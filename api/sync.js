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
    const { data: players, error: dbError } = await supabase.from('players').select('*');
    if (dbError) throw dbError;

    const updateData = [];

    for (const player of players) {
      try {
        if (!player.riot_id?.includes('#')) continue;
        const [name, tag] = player.riot_id.split('#');

        let puuid = player.puuid; 
        if (!puuid) {
          const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`);
          if (accRes.ok) {
            const account = await accRes.json();
            puuid = account.puuid;
          } else { continue; }
          await delay(50);
        }

        // 1. 티어 및 승/패 정보 가져오기 (가장 중요)
        const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`);
        const leagues = await leagueRes.json();
        const solo = Array.isArray(leagues) ? leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') : null;

        let currentTier = player.tier;
        let currentWins = player.wins || 0;
        let currentLosses = player.losses || 0;

        if (solo) {
          const krTier = TIER_KR[solo.tier] || solo.tier;
          const hasRank = !['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
          currentTier = player.manual_tier ? player.tier : `${krTier}${hasRank ? ' ' + solo.rank : ''} - ${solo.leaguePoints}LP`;
          
          // 실시간 스코어 갱신을 위해 API에서 준 승/패 값을 저장
          currentWins = solo.wins;
          currentLosses = solo.losses;
        }

        // 2. 인게임 상태 확인
        const specRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`);
        let isNowIngame = specRes.ok;

        // 3. 최근 매치 ID 확인
        const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
        const matchIds = await matchIdRes.json();
        const latestMatchId = (matchIds && matchIds.length > 0) ? matchIds[0] : player.last_match_id;

        updateData.push({
          id: player.id,
          puuid: puuid,
          tier: currentTier,
          wins: currentWins,   // 추가됨
          losses: currentLosses, // 추가됨
          is_ingame: isNowIngame,
          last_match_id: latestMatchId
        });

        await delay(150); 
      } catch (e) {
        console.error(`${player.name} 에러:`, e);
      }
    }

    // 일괄 업데이트 (minimizing API calls)
    if (updateData.length > 0) {
      await supabase.from('players').upsert(updateData);
    }

    return res.status(200).json({ success: true, count: updateData.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
