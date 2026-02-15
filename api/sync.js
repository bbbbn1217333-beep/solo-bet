const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const riotKey = process.env.RIOT_API_KEY;
  
  // [수정] 관리자 패널에서 보낸 startTime 가져오기
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
        const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') || { tier: 'UNRANKED', rank: '', leaguePoints: 0 };

        let pUpdate = {
          id: player.id,
          tier: player.manual_tier ? player.tier : `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP`.trim(),
          puuid: puuid
        };

        if (currentMatchId && currentMatchId !== player.last_match_id) {
          const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`);
          const detail = await detailRes.json();
          
          // [핵심 추가] 게임 종료 시간(gameEndTimestamp)이 버튼 누른 시간(watchTimeLimit)보다 이전이면 기록하지 않음
          const gameEndTime = detail.info.gameEndTimestamp; 
          const isNewGame = watchTimeLimit === 0 || gameEndTime > watchTimeLimit;

          const me = detail.info?.participants?.find(p => p.puuid === puuid);

          if (me && isNewGame) { // 새 게임일 때만 정산 로직 실행
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
              pUpdate.trigger_cutscene = true;
              pUpdate.target_champion = me.championName;
              pUpdate.last_kda = `${me.kills}/${me.deaths}/${me.assists}`;
            }
          } else if (me && !isNewGame) {
            // [추가] 옛날 게임이면 last_match_id만 업데이트해서 다음 감시 때 중복 체크 안 되게 함
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

