import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const RIOT_API = process.env.RIOT_API_KEY;

export default async function handler(req, res) {
    try {
        const { data: players } = await supabase.from('players').select('*');
        
        for (const player of players) {
            if (!player.riot_id?.includes('#')) continue;
            const [name, tag] = player.riot_id.split('#');

            // 1. Account-v1: PUUID 가져오기
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${RIOT_API}`);
            const acc = await accRes.json();
            if (!acc.puuid) continue;

            // 2. Spectator-v4: 실시간 게임 확인 (챔피언 아이콘 실시간 반영)
            const activeRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v4/active-games/by-summoner/${acc.puuid}?api_key=${RIOT_API}`);
            if (activeRes.status === 200) {
                const active = await activeRes.json();
                const p = active.participants.find(x => x.puuid === acc.puuid);
                // ID가 숫자로 오므로 문자열 비교를 위해 .toString() 권장
                if (p && player.champions[0] !== p.championId.toString()) {
                    let tempChamps = [...(player.champions || [])];
                    tempChamps[0] = p.championId.toString(); 
                    await supabase.from('players').update({ champions: tempChamps }).eq('id', player.id);
                }
            }

            // 3. Match-v5: 최근 매치 ID 확인 (리소스 방어)
            const matchIds = await (await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?start=0&count=1&type=ranked&api_key=${RIOT_API}`)).json();
            const currentMatchId = matchIds[0];

            if (currentMatchId && currentMatchId !== player.last_match_id) {
                const detail = await (await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${RIOT_API}`)).json();
                
                // [수정] 무효판 처리: 5분 미만 게임 시 챔피언 아이콘을 'None'으로 돌림
                if (detail.info.gameDuration < 300) {
                    let resetChamps = [...(player.champions || [])];
                    resetChamps[0] = 'None'; 
                    await supabase.from('players').update({ 
                        last_match_id: currentMatchId, 
                        champions: resetChamps 
                    }).eq('id', player.id);
                    continue; 
                }

                const p = detail.info.participants.find(x => x.puuid === acc.puuid);
                
                // 전적 및 챔피언 목록 갱신 (W/L 및 이름 자동 밀어내기)
                let newRecent = [p.win ? 'win' : 'lose', ...(player.recent || []).slice(0, 9)];
                let newChamps = [p.championName, ...(player.champions || []).slice(0, 9)];
                
                // 리그 정보 (티어/LP) 갱신
                const smRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${acc.puuid}?api_key=${RIOT_API}`);
                const sm = await smRes.json();
                const lgRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${sm.id}?api_key=${RIOT_API}`);
                const lg = await lgRes.json();
                const solo = lg.find(v => v.queueType === 'RANKED_SOLO_5x5');
                const newTier = solo ? `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP` : player.tier;

                // 데이터베이스 최종 업데이트
                await supabase.from('players').update({
                    wins: p.win ? player.wins + 1 : player.wins,
                    losses: !p.win ? player.losses + 1 : player.losses,
                    recent: newRecent,
                    champions: newChamps,
                    tier: newTier,
                    last_match_id: currentMatchId,
                    last_game_stats: { k: p.kills, d: p.deaths, a: p.assists, lpDiff: 20 }
                }).eq('id', player.id);
            }
        }
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
}
