const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const TIER_KR = {
  'CHALLENGER': '챌린저', 'GRANDMASTER': '그랜드마스터', 'MASTER': '마스터',
  'DIAMOND': '다이아몬드', 'EMERALD': '에메랄드', 'PLATINUM': '플래티넘',
  'GOLD': '골드', 'SILVER': '실버', 'BRONZE': '브론즈', 'IRON': '아이언', 'UNRANKED': '언랭크'
};

module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const riotKey = process.env.RIOT_API_KEY;

  if (!url || !key || !riotKey) return res.status(500).json({ success: false, error: "환경변수 누락" });
  const supabase = createClient(url, key);

  try {
    // 1. 모든 플레이어 데이터를 한 번에 가져옴 (최적화)
    const { data: players, error: dbError } = await supabase.from('players').select('*');
    if (dbError) throw dbError;

    const updateData = [];

    for (const player of players) {
      try {
        if (!player.riot_id?.includes('#')) continue;
        const [name, tag] = player.riot_id.split('#');

        // PUUID가 없으면 Riot 계정 API 호출
        let puuid = player.puuid; 
        if (!puuid) {
          const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`);
          if (accRes.ok) {
            const account = await accRes.json();
            puuid = account.puuid;
          } else { continue; }
          await delay(100);
        }

        // 인게임 여부 확인
        const specRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`);
        let isNowIngame = specRes.ok;

        // 최신 티어/LP 정보 가져오기 (매치 변경 상관없이 무조건 갱신하도록 수정)
        const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`);
        const leagues = await leagueRes.json();
        const solo = Array.isArray(leagues) ? leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') : null;

        let currentTier = player.tier;
        if (solo) {
          const krTier = TIER_KR[solo.tier] || solo.tier;
          const hasRank = !['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
          currentTier = player.manual_tier ? player.tier : `${krTier}${hasRank ? ' ' + solo.rank : ''} - ${solo.leaguePoints}LP`;
        } else if (!player.manual_tier) {
          currentTier = "언랭크";
        }

        // 매치 ID 확인 (전적 갱신용)
        const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
        const matchIds = await matchIdRes.json();
        const latestMatchId = (matchIds && matchIds.length > 0) ? matchIds[0] : player.last_match_id;

        // 업데이트할 데이터 구성
        updateData.push({
          id: player.id,
          puuid: puuid,
          tier: currentTier,
          is_ingame: isNowIngame,
          last_match_id: latestMatchId,
          // 컷씬 트리거는 여기서 직접 건드리지 않고 값이 변할 때 송출 패널이 감지하게 둠
        });

        await delay(200); // 속도 제한 방지
      } catch (e) {
        console.error(`${player.name} 처리 중 에러:`, e);
      }
    }

    // 2. 수집된 데이터를 단 한 번의 API 호출로 업데이트 (getValues/setValues 최적화 방식 적용)
    if (updateData.length > 0) {
      const { error: upsertError } = await supabase.from('players').upsert(updateData);
      if (upsertError) throw upsertError;
    }

    return res.status(200).json({ success: true, count: updateData.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
