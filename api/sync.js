const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ─────────────────────────────────────────
// 티어 문자열 생성
// 형식: "골드 1 - 45LP" / "마스터 - 500LP" / "언랭크"
// ─────────────────────────────────────────
const TIER_KOR = {
  "CHALLENGER": "챌린저", "GRANDMASTER": "그랜드마스터", "MASTER": "마스터",
  "DIAMOND": "다이아몬드", "EMERALD": "에메랄드", "PLATINUM": "플래티넘",
  "GOLD": "골드", "SILVER": "실버", "BRONZE": "브론즈", "IRON": "아이언"
};
const RANK_NUM = { "I": "1", "II": "2", "III": "3", "IV": "4" };

function buildTierString(solo) {
  if (!solo || !solo.tier) return "언랭크";
  const korTier = TIER_KOR[solo.tier] || solo.tier;
  const isApex = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
  if (isApex) return `${korTier} - ${solo.leaguePoints}LP`;
  const numRank = RANK_NUM[solo.rank] || solo.rank || "1";
  return `${korTier} ${numRank} - ${solo.leaguePoints}LP`;
}

// 배열 10칸 보정
function padArray(arr, length, fill) {
  const base = Array.isArray(arr) ? [...arr] : [];
  while (base.length < length) base.push(fill);
  return base;
}

module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const riotKey = process.env.RIOT_API_KEY;

  if (!url || !key || !riotKey) {
    return res.status(500).json({ success: false, error: "환경변수 누락" });
  }
  const supabase = createClient(url, key);

  try {
    const { data: players, error: dbError } = await supabase.from('players').select('*');
    if (dbError) throw dbError;

    const updateData = [];

    for (const player of players) {
      try {
        if (!player.riot_id?.includes('#')) continue;
        const [namePart, tagPart] = player.riot_id.split('#');
        if (!namePart?.trim() || !tagPart?.trim()) continue;

        // ── 1. PUUID 조회 ──
        const accRes = await fetch(
          `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(namePart.trim())}/${encodeURIComponent(tagPart.trim())}?api_key=${riotKey}`
        );
        if (!accRes.ok) {
          console.error(`[${player.name}] account 조회 실패: ${accRes.status}`);
          continue;
        }
        const account = await accRes.json();
        const puuid = account.puuid;
        if (!puuid) continue;

        // ── 2. 실시간 인게임 챔피언 감시 ──
        let liveChampId = null;
        try {
          const specRes = await fetch(
            `https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`
          );
          if (specRes.ok) {
            const specData = await specRes.json();
            const me = specData.participants?.find(p => p.puuid === puuid);
            if (me) liveChampId = me.championId;
          }
        } catch (e) { /* 인게임 아닐 때 정상 */ }

        // ── 3. 최근 매치 ID (최근 2개 조회 - 중복 방지 강화) ──
        const matchIdRes = await fetch(
          `https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=2&api_key=${riotKey}`
        );
        const matchIds = await matchIdRes.json();
        const currentMatchId = Array.isArray(matchIds) ? matchIds[0] : null;

        // ── 4. 티어 조회 (Summoner ID 경유) ──
        let apiTierStr = player.tier || "언랭크"; // 실패 시 기존 티어 유지
        let soloInfo = null;
        try {
          const sumRes = await fetch(
            `https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?api_key=${riotKey}`
          );
          if (sumRes.ok) {
            const sumData = await sumRes.json();
            const leagueRes = await fetch(
              `https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${sumData.id}?api_key=${riotKey}`
            );
            if (leagueRes.ok) {
              const leagues = await leagueRes.json();
              if (Array.isArray(leagues)) {
                soloInfo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') || null;
                // soloInfo가 없으면(언랭) "언랭크", 있으면 티어 문자열
                apiTierStr = soloInfo ? buildTierString(soloInfo) : "언랭크";
              }
            }
          }
        } catch (e) {
          console.error(`[${player.name}] 티어 조회 에러:`, e.message);
          apiTierStr = player.tier || "언랭크"; // 에러 시 기존 값 유지
        }

        // ── 5. 배열 보정 ──
        const safeRecent = padArray(player.recent, 10, 'ing');
        const safeChamps = padArray(player.champions, 10, 'None');

        // ─────────────────────────────────────────────────────
        // [핵심 수정] 감시 시작 전 게임 스킵 로직
        //
        // watch_since가 DB에 저장된 시각보다 현재 매치가 오래됐으면 → 스킵
        // watch_since가 없으면 → 최초 실행이므로 currentMatchId만 last_match_id에 저장하고 결과는 처리 안 함
        // ─────────────────────────────────────────────────────
        const watchSince = player.watch_since ? new Date(player.watch_since) : null;

        let pUpdate = {
          id: player.id,
          tier: player.manual_tier ? player.tier : apiTierStr,
          puuid: puuid,
          manual_tier: !!player.manual_tier,
          last_sync: new Date().toISOString(),
          trigger_cutscene: false,
          wins: player.wins || 0,
          losses: player.losses || 0,
          recent: safeRecent,
          champions: safeChamps,
        };

        // ── 6. 새 매치 처리 ──
        if (currentMatchId && currentMatchId !== player.last_match_id) {
          const detailRes = await fetch(
            `https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`
          );
          if (detailRes.ok) {
            const detail = await detailRes.json();
            const gameEndTime = detail.info?.gameEndTimestamp
              ? new Date(detail.info.gameEndTimestamp)
              : null;
            const me = detail.info?.participants?.find(p => p.puuid === puuid);

            // [핵심] watch_since 이전에 끝난 게임은 last_match_id만 업데이트하고 결과는 처리 안 함
            const isBeforeWatch = watchSince && gameEndTime && gameEndTime <= watchSince;

            if (isBeforeWatch) {
              // 감시 시작 전 게임 → 결과 무시, last_match_id만 저장해서 다음에 또 처리 안 되게
              console.log(`[${player.name}] 감시 전 게임 스킵: ${currentMatchId}`);
              pUpdate.last_match_id = currentMatchId;
            } else if (me) {
              const isRemake = detail.info.gameDuration < 300 || !!me.gameEndedInEarlySurrender;
              const targetIdx = safeRecent.findIndex(r => r === 'ing');
              const newRecent = [...safeRecent];
              const newChamps = [...safeChamps];

              if (isRemake) {
                if (targetIdx !== -1) newChamps[targetIdx] = "None";
                pUpdate.recent = newRecent;
                pUpdate.champions = newChamps;
                pUpdate.last_match_id = currentMatchId;
              } else {
                if (targetIdx !== -1) {
                  newRecent[targetIdx] = me.win ? 'win' : 'lose';
                  newChamps[targetIdx] = me.championName || 'None';
                }
                pUpdate.recent = newRecent;
                pUpdate.champions = newChamps;
                pUpdate.wins = (player.wins || 0) + (me.win ? 1 : 0);
                pUpdate.losses = (player.losses || 0) + (!me.win ? 1 : 0);
                pUpdate.last_match_id = currentMatchId;
                pUpdate.trigger_cutscene = true;
                pUpdate.event_type = me.win ? 'victory' : 'defeat';
                pUpdate.target_champion = me.championName || 'None';
                pUpdate.last_kda = `${me.kills}/${me.deaths}/${me.assists}`;
                pUpdate.lp_diff = soloInfo ? String(soloInfo.leaguePoints) : '0';
              }
            }
          } else {
            // 매치 상세 조회 실패해도 last_match_id는 업데이트
            pUpdate.last_match_id = currentMatchId;
          }
        } else if (liveChampId) {
          // ── 7. 인게임 중: 챔피언 ID 기록 ──
          const targetIdx = safeRecent.findIndex(r => r === 'ing');
          if (targetIdx !== -1) {
            const newChamps = [...safeChamps];
            newChamps[targetIdx] = liveChampId.toString();
            pUpdate.champions = newChamps;
          }
        }

        updateData.push(pUpdate);
      } catch (e) {
        console.error(`[${player.name || player.id}] 처리 에러:`, e.message);
      }
    }

    if (updateData.length > 0) {
      const { error: upsertErr } = await supabase
        .from('players')
        .upsert(updateData, { onConflict: 'id' });
      if (upsertErr) {
        console.error('upsert 에러:', upsertErr);
        return res.status(500).json({ success: false, error: upsertErr.message });
      }
    }

    const debugInfo = updateData.map(p => ({ id: p.id, tier: p.tier, manual: p.manual_tier }));
    return res.status(200).json({ success: true, updated: updateData.length, debug: debugInfo });
  } catch (error) {
    console.error('sync 전체 에러:', error);
    return res.status(500).json({ error: error.message });
  }
};
