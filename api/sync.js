const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const riotApiKey = process.env.RIOT_API_KEY;

    const T_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
    const R_ORDER = ['IV', 'III', 'II', 'I'];

    try {
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw dbError;

        const updateData = [];

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;
            
            const [name, tag] = player.riot_id.split('#');
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotApiKey}`);
            if (!accRes.ok) continue;
            const account = await accRes.json();

            const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=1&api_key=${riotApiKey}`);
            const matchIds = await matchIdRes.json();
            const currentMatchId = matchIds[0];

            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}?api_key=${riotApiKey}`);
            const leagues = await leagueRes.json();
            const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');

            if (!solo) continue;

            let lpDiffText = "";
            let shouldTrigger = false;
            let matchStats = null;

            const getAbsoluteLP = (tier, rank, lp) => {
                const tIdx = T_ORDER.indexOf(tier.toUpperCase());
                const lpVal = parseInt(lp) || 0;
                if (tIdx >= T_ORDER.indexOf('MASTER')) return 2800 + lpVal;
                const rIdx = R_ORDER.indexOf(rank?.toUpperCase() || "IV");
                return (tIdx * 400) + (rIdx * 100) + lpVal;
            };

            if (currentMatchId && currentMatchId !== player.last_match_id) {
                const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotApiKey}`);
                const detail = await detailRes.json();
                const me = detail.info.participants.find(p => p.puuid === account.puuid);

                if (me) {
                    shouldTrigger = true;
                    const tierMatch = player.tier.match(/([A-Z\s]+)\s?([I|V|X]+)?\s?-\s?(\d+)LP/);
                    
                    if (tierMatch) {
                        const oldTier = tierMatch[1].trim().toUpperCase();
                        const oldRank = tierMatch[2] ? tierMatch[2].trim().toUpperCase() : "I";
                        const oldLP = tierMatch[3];

                        const oldAbsLP = getAbsoluteLP(oldTier, oldRank, oldLP);
                        const newAbsLP = getAbsoluteLP(solo.tier, solo.rank || "I", solo.leaguePoints);
                        const diff = newAbsLP - oldAbsLP;

                        const isTierChanged = oldTier !== solo.tier.toUpperCase();
                        const isRankChanged = !isTierChanged && oldRank !== (solo.rank || "I").toUpperCase();

                        if (isTierChanged) {
                            // 티어 자체가 변함 (골드 -> 플래 등)
                            const status = diff > 0 ? "✨ 승격!" : "↘️ 강등";
                            lpDiffText = `${status} (${diff > 0 ? '+' : ''}${diff}LP)`;
                        } else if (isRankChanged) {
                            // 단계만 변함 (골4 -> 골3 등)
                            const status = diff > 0 ? "↗️ 승급!" : "↘️ 하락";
                            lpDiffText = `${status} (${diff > 0 ? '+' : ''}${diff}LP)`;
                        } else {
                            // 유지
                            lpDiffText = diff >= 0 ? `(+${diff}LP)` : `(${diff}LP)`;
                        }
                    } else {
                        lpDiffText = "";
                    }

                    matchStats = {
                        kda: `${me.kills}/${me.deaths}/${me.assists}`,
                        champion: me.championName,
                        win: me.win,
                        lpDiff: lpDiffText
                    };
                }
            }

            updateData.push({
                id: player.id,
                tier: `${solo.tier} ${solo.rank || ""} - ${solo.leaguePoints}LP`.replace(/\s\s/g, ' '),
                last_match_id: currentMatchId,
                last_kda: matchStats ? matchStats.kda : player.last_kda,
                lp_diff: matchStats ? matchStats.lpDiff : player.lp_diff,
                recent: shouldTrigger ? [...(player.recent || []).slice(1), matchStats.win ? 'win' : 'lose'] : player.recent,
                champions: shouldTrigger ? [...(player.champions || []).slice(1), matchStats.champion] : player.champions,
                wins: (shouldTrigger && matchStats.win) ? (player.wins + 1) : player.wins,
                losses: (shouldTrigger && !matchStats.win) ? (player.losses + 1) : player.losses,
                trigger_cutscene: shouldTrigger,
                puuid: account.puuid
            });
        }

        if (updateData.length > 0) {
            await supabase.from('players').upsert(updateData);
        }

        return res.status(200).json({ success: true, count: updateData.length });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};
