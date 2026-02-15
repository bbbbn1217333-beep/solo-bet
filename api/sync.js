const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

        // 1. PUUID 확인 (캐싱 적용)
        let puuid = player.puuid; 
        if (!puuid) {
          const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`);
          if (accRes.ok) {
            const account = await accRes.json();
            puuid = account.puuid;
          } else { continue; }
          await delay(100);
        }

        // 2. 인게임 감지 및 상태 확인
        const specRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`);
        let liveChamp = null;
        let isNowIngame = false;

        if (specRes.ok) {
          const specData = await specRes.json();
          const me = specData.participants?.find(p => p.puuid === puuid);
          if (me) {
            liveChamp = me.championId;
            isNowIngame = true;
          }
        }

        const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
        const matchIds = await matchIdRes.json();
        const currentMatchId = matchIds[0];

        let pUpdate = { 
          id: player.id, 
          puuid: puuid, 
          is_ingame: isNowIngame, // 인게임 상태 업데이트
          trigger_cutscene: false 
        };

        // 3. 티어 및 전적 정산 조건
        // - 게임이 새로 끝났거나 (Match ID 변경)
        // - 아직 티어 정보가 없거나 (초기 실행)
        const isMatchChanged = currentMatchId && currentMatchId !== player.last_match_id;
        const isFirstTime = !player.tier || player.tier === "UNRANKED";

        if (isMatchChanged || isFirstTime) {
          // 티어 정보 조회
          const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`);
          const leagues = await leagueRes.json();
          const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') || { tier: 'UNRANKED', rank: '', leaguePoints: 0 };
          
          pUpdate.tier = player.manual_tier ? player.tier : `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP`.trim();

          // 게임 종료 정산
          if (isMatchChanged) {
            const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`);
            const detail = await detailRes.json();
            const me = detail.info?.participants?.find(p => p.puuid === puuid);

            if (me) {
              const isRemake = detail.info.gameDuration < 300 || me.gameEndedInEarlySurrender;
              const newRecent = [...(player.recent || Array(10).fill("ing"))];
              const newChamps = [...(player.champions || Array(10).fill("None"))];
              const targetIdx = newRecent.findIndex(r => r === 'ing');

              if (!isRemake) {
                if (targetIdx !== -1) {
                  newRecent[targetIdx] = me.win ? 'win' : 'lose';
                  newChamps[targetIdx] = me.championName;
                }
                pUpdate.recent = newRecent;
                pUpdate.champions = newChamps;
                pUpdate.wins = me.win ? (player.wins + 1) : player.wins;
                pUpdate.losses = !me.win ? (player.losses + 1) : player.losses;
                pUpdate.last_match_id = currentMatchId;
                pUpdate.trigger_cutscene = true;
                pUpdate.target_champion = me.championName;
                pUpdate.last_kda = `${me.kills}/${me.deaths}/${me.assists}`;
              } else {
                pUpdate.last_match_id = currentMatchId;
              }
            }
          }
        } else {
          // 평시(게임 중이거나 대기 중) - 티어 조회 생략하여 API 아낌
          pUpdate.tier = player.tier;
          if (isNowIngame && liveChamp) {
            const newChamps = [...(player.champions || Array(10).fill("None"))];
            const targetIdx = (player.recent || []).findIndex(r => r === 'ing');
            if (targetIdx !== -1) newChamps[targetIdx] = liveChamp.toString();
            pUpdate.champions = newChamps;
          }
        }

        updateData.push(pUpdate);
        await delay(250); // 라이엇 API 호출 간격 마진

      } catch (e) { console.error(player.name, "에러:", e); }
    }

    // [중요] 한 번에 업데이트 (Consolidated Update)
    if (updateData.length > 0) {
      await supabase.from('players').upsert(updateData);
    }
    
    return res.status(200).json({ success: true });
  } catch (error) { 
    return res.status(500).json({ error: error.message }); 
  }
};
