const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ✅ [수정] 영문 티어 → 한글 매핑
const TIER_KOR = {
  "CHALLENGER": "챌린저", "GRANDMASTER": "그랜드마스터", "MASTER": "마스터",
  "DIAMOND": "다이아몬드", "EMERALD": "에메랄드", "PLATINUM": "플래티넘",
  "GOLD": "골드", "SILVER": "실버", "BRONZE": "브론즈", "IRON": "아이언"
};

// ✅ [수정] 로마자 rank → 숫자 변환 (파싱 불안정 문제 해결)
const RANK_NUM = { "I": "1", "II": "2", "III": "3", "IV": "4" };

// ✅ [핵심] 티어 문자열을 관리자 패널 findEngTierKey()와 완벽히 일치하는 형식으로 생성
// 형식: "골드 1 - 45LP"  (한글 티어 + 숫자 단계 + 하이픈 + LP)
// 마스터 이상: "마스터 - 500LP"
function buildTierString(solo) {
  if (!solo) return "언랭크";
  const korTier = TIER_KOR[solo.tier] || solo.tier;
  const isApex = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
  if (isApex) {
    return `${korTier} - ${solo.leaguePoints}LP`;
  }
  const numRank = RANK_NUM[solo.rank] || solo.rank;
  return `${korTier} ${numRank} - ${solo.leaguePoints}LP`;
}

module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const riotKey = process.env.RIOT_API_KEY;

  if (!url || !key || !riotKey) return res.status(500).json({ success: false, error: "환경변수 누락" });
  const supabase = createClient(url, key);

  try {
    const { data: players, error: dbError } = await supabase.from('players').select('*');
    if (dbError) throw dbError;

    const updateData = [];

    for (const player of players) {
      try {
        if (!player.riot_id?.includes('#')) continue;
        const [name, tag] = player.riot_id.split('#');

        // 1. PUUID 조회
        const accRes = await fetch(
          `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`
        );
        if (!accRes.ok) { console.error(`${player.name} account 조회 실패: ${accRes.status}`); continue; }
        const account = await accRes.json();
        const puuid = account.puuid;
        if (!puuid) continue;

        // 2. 인게임 감시 (실시간 챔피언 반영)
        const specRes = await fetch(
          `https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`
        );
        let liveChampId = null;
        if (specRes.ok) {
          const specData = await specRes.json();
          const me = specData.participants?.find(p => p.puuid === puuid);
          if (me) liveChampId = me.championId; // 숫자 ID
        }

        // 3. 최근 매치 ID 조회
        const matchIdRes = await fetch(
          `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`
        );
        const matchIds = await matchIdRes.json();
        const currentMatchId = Array.isArray(matchIds) ? matchIds[0] : null;

        // 4. 티어 조회 (PUUID 기반 - Summoner ID 중간 단계 생략 가능)
        const leagueRes = await fetch(
          `https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`
        );
        let apiTierStr = "언랭크";
        if (leagueRes.ok) {
          const leagues = await leagueRes.json();
          if (Array.isArray(leagues)) {
            const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
            // ✅ [수정] 통일된 형식으로 변환
            apiTierStr = buildTierString(solo);
          }
        }

        let pUpdate = {
          id: player.id,
          // ✅ manual_tier가 true면 기존 tier 보존, false면 API 값으로 갱신
          tier: player.manual_tier ? player.tier : apiTierStr,
          puuid: puuid,
          manual_tier: !!player.manual_tier,
          last_sync: new Date().toISOString() // ✅ 동기화 시각 업데이트
        };

        // 5. 새 매치 결과 처리
        if (currentMatchId && currentMatchId !== player.last_match_id) {
          const detailRes = await fetch(
            `https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`
          );
          if (detailRes.ok) {
            const detail = await detailRes.json();
            const me = detail.info?.participants?.find(p => p.puuid === puuid);

            if (me) {
              const isRemake = detail.info.gameDuration < 300 || me.gameEndedInEarlySurrender;
              const newRecent = [...(player.recent || Array(10).fill("ing"))];
              const newChamps = [...(player.champions || Array(10).fill("None"))];

              // ✅ 첫 번째 'ing' 슬롯을 찾아서 결과 기록
              const targetIdx = newRecent.findIndex(r => r === 'ing');

              if (isRemake) {
                // 다시하기: 챔피언 이름 지우고 진행 중 유지
                if (targetIdx !== -1) newChamps[targetIdx] = "None";
                pUpdate.recent = newRecent;
                pUpdate.champions = newChamps;
                pUpdate.last_match_id = currentMatchId;
                pUpdate.trigger_cutscene = false;
              } else {
                if (targetIdx !== -1) {
                  newRecent[targetIdx] = me.win ? 'win' : 'lose';
                  newChamps[targetIdx] = me.championName; // 영문 챔피언 ID
                }
                pUpdate.recent = newRecent;
                pUpdate.champions = newChamps;
                pUpdate.wins = me.win ? (player.wins || 0) + 1 : (player.wins || 0);
                pUpdate.losses = !me.win ? (player.losses || 0) + 1 : (player.losses || 0);
                pUpdate.last_match_id = currentMatchId;

                // 컷씬 트리거
                pUpdate.trigger_cutscene = true;
                pUpdate.event_type = me.win ? 'victory' : 'defeat';
                pUpdate.target_champion = me.championName;
                pUpdate.last_kda = `${me.kills}/${me.deaths}/${me.assists}`;
                pUpdate.lp_diff = solo ? solo.leaguePoints : 0;
              }
            }
          }
        } else if (liveChampId) {
          // ✅ 인게임 중: champions 배열의 첫 'ing' 슬롯에 실시간 챔피언 ID 저장
          const newChamps = [...(player.champions || Array(10).fill("None"))];
          const targetIdx = (player.recent || []).findIndex(r => r === 'ing');
          if (targetIdx !== -1) {
            // 숫자 ID를 문자열로 저장 (관리자 패널의 idToKorMap[champId]가 숫자 key로 매핑)
            newChamps[targetIdx] = liveChampId.toString();
          }
          pUpdate.champions = newChamps;
          pUpdate.trigger_cutscene = false;
        }

        updateData.push(pUpdate);
      } catch (e) {
        console.error(`${player.name} 처리 에러:`, e.message);
      }
    }

    if (updateData.length > 0) {
      const { error } = await supabase.from('players').upsert(updateData, { onConflict: 'id' });
      if (error) console.error('upsert 에러:', error);
    }

    return res.status(200).json({ success: true, updated: updateData.length });
  } catch (error) {
    console.error('sync 전체 에러:', error);
    return res.status(500).json({ error: error.message });
  }
};

