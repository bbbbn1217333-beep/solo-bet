const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY;

    // 🔎 환경변수 체크
    console.log("RIOT_API_KEY 존재:", !!riotApiKey);
    console.log("RIOT_API_KEY 길이:", riotApiKey?.length);

    if (!riotApiKey) {
        return res.status(200).json({
            success: false,
            reason: "RIOT_API_KEY 미설정"
        });
    }

    if (!supabaseUrl || !supabaseKey) {
        return res.status(200).json({
            success: false,
            reason: "SUPABASE 환경변수 미설정"
        });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const { data: players, error: dbError } = await supabase
            .from('players')
            .select('*');

        if (dbError) throw new Error(dbError.message);
        if (!players || players.length === 0) {
            return res.status(200).json({ success: true, message: "플레이어 없음" });
        }

        const tierNames = {
            CHALLENGER: '챌린저',
            GRANDMASTER: '그랜드마스터',
            MASTER: '마스터',
            DIAMOND: '다이아몬드',
            EMERALD: '에메랄드',
            PLATINUM: '플래티넘',
            GOLD: '골드',
            SILVER: '실버',
            BRONZE: '브론즈',
            IRON: '아이언'
        };

        for (const player of players) {
            if (player.manual_tier) continue;
            if (!player.riot_id || !player.riot_id.includes('#')) continue;

            const [name, tag] = player.riot_id.split('#');

            console.log(`\n===== ${name} 조회 시작 =====`);

            // 1️⃣ Account API
            const accRes = await fetch(
                `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}`,
                {
                    headers: {
                        "X-Riot-Token": riotApiKey
                    }
                }
            );

            if (!accRes.ok) {
                console.error("Account API 실패:", accRes.status, await accRes.text());
                continue;
            }

            const account = await accRes.json();

            // 2️⃣ Summoner API
            const summRes = await fetch(
                `https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`,
                {
                    headers: {
                        "X-Riot-Token": riotApiKey
                    }
                }
            );

            if (!summRes.ok) {
                console.error("Summoner API 실패:", summRes.status, await summRes.text());
                continue;
            }

            const summoner = await summRes.json();

            // 3️⃣ League API
            const leagueRes = await fetch(
                `https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}`,
                {
                    headers: {
                        "X-Riot-Token": riotApiKey
                    }
                }
            );

            if (!leagueRes.ok) {
                console.error("League API 실패:", leagueRes.status, await leagueRes.text());
                continue;
            }

            const leagues = await leagueRes.json();

            let tierStr = "언랭크";

            if (Array.isArray(leagues)) {
                const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');

                if (solo) {
                    const rawTier = solo.tier.toUpperCase();
                    const tierKor = tierNames[rawTier] || rawTier;
                    const isHigh = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(rawTier);
                    const rank = isHigh ? "" : ` ${solo.rank}`;

                    tierStr = `${tierKor}${rank} - ${solo.leaguePoints}LP`;
                }
            }

            await supabase
                .from('players')
                .update({
                    tier: tierStr,
                    puuid: account.puuid
                })
                .eq('id', player.id);

            console.log(`${name} 갱신 완료: ${tierStr}`);
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("전체 에러:", error);
        return res.status(200).json({
            success: false,
            reason: error.message
        });
    }
};
