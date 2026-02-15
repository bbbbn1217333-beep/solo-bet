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

        // 1. PUUID 확인 (없으면 가져오기)
        let puuid = player.puuid; 
        if (!puuid) {
          const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`);
          if (accRes.ok) {
            const account = await accRes.json();
            puuid = account.puuid;
          } else { continue; }
          await delay(100);
        }

        // 2. 상태 체크 (인게임 & 최근 매치 ID)
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

        let pUpdate = { id: player.id, puuid: puuid, trigger_cutscene: false };

        // --- [수정 포인트] 티어 업데이트 결정 로직 ---
        // 조건: 게임이 끝났거나(ID변경) OR 아직 티어 정보가 아예 없는 경우(초기 실행)
        const isMatchChanged = currentMatchId && currentMatchId !== player.last_match_id;
        const isFirstTime = !player.tier || player.tier === "UNRANKED";

        if (isMatchChanged || isFirstTime) {
          const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}?api_key=${riotKey}`);
          const leagues = await leagueRes.json();
          const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') || { tier: 'UNRANKED', rank: '', leaguePoints: 0 };
          
          pUpdate.tier = player.manual_tier ? player.tier : `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP`.trim();

          // 게임 종료 시 상세 정산 로직
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
          // 게임 중이거나 대기 중일 때는 기존 데이터 유지 (라이엇 호출 X)
          pUpdate.tier = player.tier;
          if (liveChamp) {
            const newChamps = [...(player.champions || Array(10).fill("None"))];
            const targetIdx = (player.recent || []).findIndex(r => r === 'ing');
            if (targetIdx !== -1) newChamps[targetIdx] = liveChamp.toString();
            pUpdate.champions = newChamps;
          }
        }

        updateData.push(pUpdate);
        await delay(200); // 플레이어 간 간격

      } catch (e) { console.error(player.name, "에러:", e); }
    }

    if (updateData.length > 0) {
      await supabase.from('players').upsert(updateData);
    }
    
    return res.status(200).json({ success: true });
  } catch (error) { 
    return res.status(500).json({ error: error.message }); 
  }
};
