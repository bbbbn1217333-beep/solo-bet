const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

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

        // 1. PUUID 가져오기
        const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`);
        if (!accRes.ok) continue;
        const account = await accRes.json();
        const puuid = account.puuid;

        // 2. 인게임 감지 (spectator-v5)
        const specRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}?api_key=${riotKey}`);
        let liveChamp = null;
        if (specRes.ok) {
          const specData = await specRes.json();
          const me = specData.participants?.find(p => p.puuid === puuid);
          if (me) liveChamp = me.championId; 
        }

        // 3. 최근 매치 ID 및 티어 정보
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

        // 4. 게임 종료 정산
        if (currentMatchId && currentMatchId !== player.last_match_id) {
          const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`);
          const detail = await detailRes.json();
          const me = detail.info?.participants?.find(p => p.puuid === puuid);

          if (me) {
            // 무효판(다시하기) 체크: 5분 미만 혹은 조기 항복
            const isRemake = detail.info.gameDuration < 300 || me.gameEndedInEarlySurrender;
            const newRecent = [...(player.recent || Array(10).fill("ing"))];
            const newChamps = [...(player.champions || Array(10).fill("None"))];
            const targetIdx = newRecent.findIndex(r => r === 'ing');

            if (isRemake) {
              // 무효판이면 챔피언만 비우고 기록 안함
              if (targetIdx !== -1) newChamps[targetIdx] = "None";
              pUpdate.recent = newRecent;
              pUpdate.champions = newChamps;
              pUpdate.last_match_id = currentMatchId;
              pUpdate.trigger_cutscene = false;
            } else {
              // 정상 판정 (탈주 패배 포함)
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
          }
        } else if (liveChamp) {
          // 게임 진행 중일 때 챔피언 이름 매핑 (ID를 이름으로 변환하는 과정이 필요하지만, 
          // 간단하게 송출용 패널의 fixChamp 함수가 ID도 처리하므로 ID를 문자열로 저장)
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

