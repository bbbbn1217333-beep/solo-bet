const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 티어 한글 변환용 객체
const TIER_KR = {
  'CHALLENGER': '챌린저',
  'GRANDMASTER': '그랜드마스터',
  'MASTER': '마스터',
  'DIAMOND': '다이아몬드',
  'EMERALD': '에메랄드',
  'PLATINUM': '플래티넘',
  'GOLD': '골드',
  'SILVER': '실버',
  'BRONZE': '브론즈',
  'IRON': '아이언',
  'UNRANKED': '언랭크'
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
          await delay(100);
        }

        const specRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`);
        let liveChamp = null;
        let isNowIngame = false;
        if (specRes.ok) {
          const specData = await specRes.json();
          const me = specData.participants?.find(p => p.puuid === puuid);
          if (me) { liveChamp = me.championId; isNowIngame = true; }
        }

        const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
        const matchIds = await matchIdRes.json();
        const currentMatchId = (matchIds && matchIds.length > 0) ? matchIds[0] : player.last_match_id;

        let pUpdate = { id: player.id, puuid: puuid, is_ingame: isNowIngame, trigger_cutscene: false };

        const checkTier = player.tier ? player.tier.toUpperCase() : "";
        const isFirstTime = !checkTier || checkTier.includes("UNRANKED") || checkTier.includes("언랭크") || checkTier === "NULL";
        const isMatchChanged = currentMatchId && currentMatchId !== player.last_match_id;

        if (isMatchChanged || isFirstTime) {
          const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`);
          const leagues = await leagueRes.json();
          const solo = Array.isArray(leagues) ? leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') : null;
          
          if (solo) {
            const krTier = TIER_KR[solo.tier] || solo.tier;
            // 마스터 이상은 숫자가 없으므로 체크
            const hasRank = !['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
            // 형식: 챌린저 - 1456LP 또는 골드 4 - 50LP
            pUpdate.tier = player.manual_tier ? player.tier : `${krTier}${hasRank ? ' ' + solo.rank : ''} - ${solo.leaguePoints}LP`;
          } else {
            pUpdate.tier = player.manual_tier ? player.tier : "언랭크";
          }
          // ... (게임 종료 정산 로직 동일)
        } else {
          pUpdate.tier = player.tier;
        }

        updateData.push(pUpdate);
        await delay(250);
      } catch (e) { console.error(player.name, "에러:", e); }
    }

    if (updateData.length > 0) await supabase.from('players').upsert(updateData);
    return res.status(200).json({ success: true });
  } catch (error) { return res.status(500).json({ error: error.message }); }
};
