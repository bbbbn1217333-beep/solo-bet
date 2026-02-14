import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const RIOT_API = process.env.RIOT_API_KEY;

export default async function handler(req, res) {
    try {
        const { data: players } = await supabase.from('players').select('*');
        
        for (const player of players) {
            if (!player.riot_id?.includes('#')) continue;
            const [name, tag] = player.riot_id.split('#');

            // 1. PUUID 캐싱 로직 (DB에 있으면 API 호출 스킵)
            let puuid = player.puuid;
            if (!puuid) {
                const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${RIOT_API}`);
                const acc = await accRes.json();
                puuid = acc.puuid;
                if (puuid) await supabase.from('players').update({ puuid }).eq('id', player.id);
            }
            if (!puuid) continue;

            // 2. Spectator-v4: 실시간 게임 확인 (게임 시작 감지)
            const activeRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v4/active-games/by-summoner/${puuid}?api_key=${RIOT_API}`);
            if (activeRes.status === 200) {
                const active = await activeRes.json();
                const p = active.participants.find(x => x.puuid === puuid);
                // 게임 중일 때는 첫 번째 슬롯(index 0)에 현재 챔피언 ID를 박아둠
                if (p) {
                    let tempChamps = [...(player.champions || Array(10).fill('None'))];
                    // 숫자 ID를 이름으로 변환하지 않아도 송출화면의 fixChamp가 처리함
                    tempChamps[0] = p.championId.toString(); 
                    let tempRecent = [...(player.recent || Array(10).fill('ing'))];
                    tempRecent[0] = 'ing'; // 진행 중 표시

                    await supabase.from('players').update({ 
                        champions: tempChamps,
                        recent: tempRecent 
                    }).eq('id', player.id);
                    continue; // 게임 중이면 매치 체크 건너뜀
                }
            }

            // 3. Match-v5: 최근 매치 확인 (게임 종료 감지)
            const matchIds = await (await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&type=ranked&api_key=${RIOT_API}`)).json();
            const currentMatchId = matchIds[0];

            if (currentMatchId && currentMatchId !== player.last_match_id) {
                const detail = await (await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${RIOT_API}`)).json();
                
                // 무효판 처리 (5분 미만)
                if (detail.info.gameDuration < 300) {
                    await supabase.from('players').update({ last_match_id: currentMatchId }).eq('id', player.id);
                    continue; 
                }

                const p = detail.info.participants.find(x => x.puuid === puuid);
                
                // 전적 밀어내기 (0번 인덱스에 새 데이터 넣고 나머지는 한 칸씩 뒤로)
                let newRecent = [p.win ? 'win' : 'lose', ...(player.recent || []).slice(0, 9)];
                let newChamps = [p.championName, ...(player.champions || []).slice(0, 9)];
                
                // 리그 정보 갱신
                const smRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?api_key=${RIOT_API}`);
                const sm = await smRes.json();
                const lgRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${sm.id}?api_key=${RIOT_API}`);
                const lg = await lgRes.json();
                const solo = lg.find(v => v.queueType === 'RANKED_SOLO_5x5');
                const newTier = solo ? `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP` : player.tier;

                // DB 최종 업데이트 및 컷씬 트리거
                await supabase.from('players').update({
                    wins: p.win ? player.wins + 1 : player.wins,
                    losses: !p.win ? player.losses + 1 : player.losses,
                    recent: newRecent,
                    champions: newChamps,
                    tier: newTier,
                    last_match_id: currentMatchId,
                    last_kda: `${p.kills}/${p.deaths}/${p.assists}`,
                    trigger_cutscene: true // 송출화면에 컷씬 띄우기
                }).eq('id', player.id);
            }
        }
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
}
