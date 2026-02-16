const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// [추가] 영문 티어를 한글로 매핑하는 테이블
const TIER_KOR = {
  "CHALLENGER": "챌린저", "GRANDMASTER": "그랜드마스터", "MASTER": "마스터",
  "DIAMOND": "다이아몬드", "EMERALD": "에메랄드", "PLATINUM": "플래티넘",
  "GOLD": "골드", "SILVER": "실버", "BRONZE": "브론즈", "IRON": "아이언"
};

module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const riotKey = process.env.RIOT_API_KEY;
  
  const { startTime } = req.query;
  const watchTimeLimit = startTime ? parseInt(startTime) : 0;

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

        const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`);
        if (!accRes.ok) continue;
        const account = await accRes.json();
        const puuid = account.puuid;

        const specRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`);
        let liveChamp = null;
        if (specRes.ok) {
          const specData = await specRes.json();
          const me = specData.participants?.find(p => p.puuid === puuid);
          if (me) liveChamp = me.championId; 
        }

        const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
        const matchIds = await matchIdRes.json();
        const currentMatchId = matchIds[0];

        const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`);
        const leagues = await leagueRes.json();
        const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');

        // [핵심수정] 티어 텍스트를 관리자 페이지와 100% 일치시킴
        let apiTierStr = "언랭크";
        if (solo) {
          const korTier = TIER_KOR[solo.tier] || solo.tier;
          // 마스터 이상은 단계(rank)가 없으므로 별도 처리
          const hasRank = !['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
          apiTierStr = `${korTier}${hasRank ? ' ' + solo.rank : ''} - ${solo.leaguePoints}LP`;
        }

        let pUpdate = {
          id: player.id,
          tier: player.manual_tier ? player.tier : apiTierStr,
          puuid: puuid,
          manual_tier: !!player.manual_tier
        };

        if (currentMatchId && currentMatchId !== player.last_match_id) {
          const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`);
          const detail = await detailRes.json();
          
          const gameEndTime = detail.info.gameEndTimestamp; 
          const isNewGame = watchTimeLimit === 0 || gameEndTime > watchTimeLimit;
          const me = detail.info?.participants?.find(p => p.puuid === puuid);

          if (me && isNewGame) {
            const isRemake = detail.info.gameDuration < 300 || me.gameEndedInEarlySurrender;
            const newRecent = [...(player.recent || Array(10).fill("ing"))];
            const newChamps = [...(player.champions || Array(10).fill("None"))];
            const targetIdx = newRecent.findIndex(r => r === 'ing');

            if (isRemake) {
              if (targetIdx !== -1) newChamps[targetIdx] = "None";
              pUpdate.recent = newRecent;
              pUpdate.champions = newChamps;
              pUpdate.last_match_id = currentMatchId;
              pUpdate.trigger_cutscene = false;
            } else {
              if (targetIdx !== -1) {
                newRecent[targetIdx] = me.win ? 'win' : 'lose';
                newChamps[targetIdx] = me.championName;
              }
              pUpdate.recent = newRecent;
              pUpdate.champions = newChamps;
              pUpdate.wins = me.win ? (player.wins + 1) : player.wins;
              pUpdate.losses = !me.win ? (player.losses + 1) : player.losses;
              pUpdate.last_match_id = currentMatchId;
              
              // 컷씬 관련 데이터 (점수 변동 노출을 위해 중요)
              pUpdate.trigger_cutscene = true;
              pUpdate.target_champion = me.championName;
              pUpdate.last_kda = `${me.kills}/${me.deaths}/${me.assists}`;
            }
          } else if (me && !isNewGame) {
            pUpdate.last_match_id = currentMatchId;
          }
        } else if (liveChamp) {
          const newChamps = [...(player.champions || Array(10).fill("None"))];
          const targetIdx = (player.recent || []).findIndex(r => r === 'ing');
          if (targetIdx !== -1) {
            newChamps[targetIdx] = liveChamp.toString();
          }
          pUpdate.champions = newChamps;
          pUpdate.trigger_cutscene = false;
        }

        updateData.push(pUpdate);
      } catch (e) { console.error(player.name, "에러:", e); }
    }

    if (updateData.length > 0) await supabase.from('players').upsert(updateData);
    return res.status(200).json({ success: true });
  } catch (error) { return res.status(500).json({ error: error.message }); }
};

