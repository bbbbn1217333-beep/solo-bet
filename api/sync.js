// sync.js (최종 최적화 및 컷씬 트리거 버전)
const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const riotApiKey = process.env.RIOT_API_KEY;

    try {
        const { data: players } = await supabase.from('players').select('*');
        const updateData = [];

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;
            const [name, tag] = player.riot_id.split('#');

            // 1. PUUID 및 최근 매치 ID 가져오기
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${riotApiKey}`);
            if (!accRes.ok) continue;
            const account = await accRes.json();

            const matchRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=1&api_key=${riotApiKey}`);
            const matchIds = await matchRes.json();
            const lastMatchId = matchIds[0];

            // 2. 새로운 게임 종료 감지!! (핵심)
            let matchStats = null;
            let shouldTrigger = false;

            if (lastMatchId && lastMatchId !== player.last_match_id) {
                const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${lastMatchId}?api_key=${riotApiKey}`);
                const detail = await detailRes.json();
                const me = detail.info.participants.find(p => p.puuid === account.puuid);
                
                if (me) {
                    matchStats = {
                        kda: `${me.kills}/${me.deaths}/${me.assists}`,
                        champion: me.championName,
                        win: me.win
                    };
                    shouldTrigger = true; // 새로운 게임이면 컷씬 트리거 발동!
                }
            }

            // 3. 티어 정보 가져오기
            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}?api_key=${riotApiKey}`);
            const leagues = await leagueRes.json();
            const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
            
            let tierStr = player.tier;
            if (solo) {
                tierStr = `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP`;
            }

            // 4. 업데이트 리스트에 담기
            updateData.push({
                id: player.id,
                tier: tierStr,
                last_match_id: lastMatchId,
                last_kda: matchStats ? matchStats.kda : player.last_kda,
                // 최근 전적 배열 업데이트 (승리/패배 추가)
                recent: shouldTrigger ? [...(player.recent || []).slice(1), matchStats.win ? 'win' : 'lose'] : player.recent,
                champions: shouldTrigger ? [...(player.champions || []).slice(1), matchStats.champion] : player.champions,
                trigger_cutscene: shouldTrigger, // 송출 화면에 신호 보냄!
                wins: (shouldTrigger && matchStats.win) ? (player.wins + 1) : player.wins,
                losses: (shouldTrigger && !matchStats.win) ? (player.losses + 1) : player.losses
            });
        }

        if (updateData.length > 0) {
            await supabase.from('players').upsert(updateData);
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
