const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return res.status(200).json({ success: false, reason: "SUPABASE 환경변수 미설정" });
    }

    if (!riotApiKey) {
        return res.status(200).json({ success: false, reason: "RIOT_API_KEY 미설정" });
    }

    console.log("RIOT KEY 존재:", !!riotApiKey);
    console.log("RIOT KEY 길이:", riotApiKey?.length);

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const { data: players, error: dbError } = await supabase
            .from('players')
            .select('*');

        if (dbError) throw new Error(`DB Read Error: ${dbError.message}`);
        if (!players || players.length === 0) {
            return res.status(200).json({ success: true, message: "플레이어 없음" });
        }

        const tierNames = {
            'CHALLENGER': '챌린저',
            'GRANDMASTER': '그랜드마스터',
            'MASTER': '마스터',
            'DIAMOND': '다이아몬드',
            'EMERALD': '에메랄드',
            'PLATINUM': '플래티넘',
            'GOLD': '골드',
            'SILVER': '실버',
            'BRONZE': '브론즈',
            'IRON': '아이언'
        };

        for (const player of players) {

            if (player.manual_tier) continue;
            if (!player.riot_id || !player.riot_id.includes('#')) continue;

            const [name, tag] = player.riot_id.split('#');

            console.log(`\n===== ${name} 조회 시작 =====`);

            // 1️⃣ Riot Account API (PUUID)
            const accRes = await fetch(
                `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}`,
                {
                    headers: {
                        "X-Riot-Token": riotApiKey
                    }
                }
            );

            if (!accRes.ok) {
                const errText = await accRes.text();
                console.error("Account API 실패:", accRes.status, errText);
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
                const errText = await summRes.text();
                console.error("Summoner API 실패:", summRes.status, errText);
                continue;
            }

            const summoner = await summRes.json();

            // 3️⃣ League API (솔로랭크)
            const leagueRes = await fetch(
                `https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}`,
                {
                    headers: {
                        "X-Riot-Token": riotApiKey
                    }
                }
            );

            if (!leagueRes.ok) {
                const errText = await leagueRes.text();
                console.error("League API 실패:", leagueRes.status, errText);
                continue;
            }

            const leagues = await leagueRes.json();

            console.log("League Raw:", JSON.stringify(leagues));

            let tierStr = "언랭크";

            if (Array.isArray(leagues)) {
                const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');

                if (solo) {
                    const rawTier = solo.tier.toUpperCase();
                    const tierKor = tierNames[rawTier] || rawTier;
                    const isHigh = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(rawTier);
                    const rank = isHigh ? "" : " " + solo.rank;

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
        return res.status(200).json({ success: false, reason: error.message });
    }
};

