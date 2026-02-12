import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const RIOT_API = process.env.RIOT_API_KEY;

export default async function handler(req, res) {
    try {
        const { data: players } = await supabase.from('players').select('*');
        
        for (const player of players) {
            if (!player.riot_id?.includes('#')) continue;
            const [name, tag] = player.riot_id.split('#');

            // 1. PUUID 및 현재 게임 확인 (사용 챔피언 실시간 감지용)
            const acc = await (await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${RIOT_API}`)).json();
            if (!acc.puuid) continue;

            // [추가] 실시간 인게임 정보 확인 (게임 시작 시 챔피언 노출용)
            const activeRes = await fetch(`https://kr.api.riotgames.com/lol/spectator/v4/active-games/by-summoner/${acc.puuid}?api_key=${RIOT_API}`);
            if (activeRes.status === 200) {
                const active = await activeRes.json();
                const p = active.participants.find(x => x.puuid === acc.puuid);
                // 게임 중이면 첫 번째 슬롯에 현재 챔피언 미리 노출
                if (p && player.champions[0] !== active.championId) {
                    let champs = [...player.champions];
                    champs[0] = active.championId; // 챔피언 ID 저장 (render 시 변환)
                    await supabase.from('players').update({ champions: champs }).eq('id', player.id);
                }
            }

            // 2. 최근 매치 ID 가져오기
            const matches = await (await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?start=0&count=1&type=ranked&api_key=${RIOT_API}`)).json();
            const lastMatchId = matches[0];

            // [핵심] 리소스 방지: 저장된 마지막 매치ID와 다를 때만(게임 종료 시) 실행
            if (lastMatchId && lastMatchId !== player.last_match_id) {
                const detail = await (await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${lastMatchId}?api_key=${RIOT_API}`)).json();
                
                // 무효판 처리 (게임 시간이 너무 짧으면 스킵)
                if (detail.info.gameDuration < 300) {
                    await supabase.from('players').update({ last_match_id: lastMatchId }).eq('id', player.id);
                    continue;
                }

                const p = detail.info.participants.find(x => x.puuid === acc.puuid);
                
                // 전적 및 챔피언 히스토리 업데이트
                let newRecent = [p.win ? 'win' : 'lose', ...player.recent.slice(0, 9)];
                let newChamps = [p.championName, ...player.champions.slice(0, 9)];
                
                // 티어 및 LP 정보 갱신
                const sm = await (await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${acc.puuid}?api_key=${RIOT_API}`)).json();
                const lg = await (await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${sm.id}?api_key=${RIOT_API}`)).json();
                const solo = lg.find(v => v.queueType === 'RANKED_SOLO_5x5');
                const newTier = solo ? `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP` : player.tier;

                // 컷신용 메타데이터 포함 업데이트
                await supabase.from('players').update({
                    wins: p.win ? player.wins + 1 : player.wins,
                    losses: !p.win ? player.losses + 1 : player.losses,
                    recent: newRecent,
                    champions: newChamps,
                    tier: newTier,
                    last_match_id: lastMatchId,
                    last_game_stats: { k: p.kills, d: p.deaths, a: p.assists, lpDiff: 20 } // LP 차이는 이전 데이터와 비교 로직 추가 가능
                }).eq('id', player.id);
            }
        }
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
}
