const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY;

    if (!riotApiKey) return res.status(200).json({ success: false, reason: "API_KEY 미설정" });

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // 1. 플레이어 목록 한 번에 가져오기
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw new Error(`DB Read Error: ${dbError.message}`);

        const tierNames = {
            'CHALLENGER': '챌린저', 'GRANDMASTER': '그랜드마스터', 'MASTER': '마스터',
            'DIAMOND': '다이아몬드', 'EMERALD': '에메랄드', 'PLATINUM': '플래티넘',
            'GOLD': '골드', 'SILVER': '실버', 'BRONZE': '브론즈', 'IRON': '아이언'
        };

        // 업데이트할 데이터를 모아두는 배열 (최적화 핵심)
        const updateData = [];

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;
            const [name, tag] = player.riot_id.split('#');

            // 1️⃣ Account API (PUUID 획득)
            const accRes = await fetch(
                `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotApiKey}`
            );
            if (!accRes.ok) continue;
            const account = await accRes.json();

            // 2️⃣ League API (승인된 by-puuid 엔드포인트 사용)
            const leagueRes = await fetch(
                `https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}?api_key=${riotApiKey}`
            );
            if (!leagueRes.ok) continue;

            const leagues = await leagueRes.json();
            let tierStr = "언랭크";

            if (Array.isArray(leagues)) {
                const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
                if (solo) {
                    const rawTier = solo.tier.toUpperCase();
                    const tierKor = tierNames[rawTier] || rawTier;
                    const rank = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(rawTier) ? "" : " " + solo.rank;
                    tierStr = `${tierKor}${rank} - ${solo.leaguePoints}LP`;
                }
            }

            // 3. 업데이트할 내용을 배열에 추가
            updateData.push({
                id: player.id,
                tier: tierStr,
                puuid: account.puuid
            });

            console.log(`[Queue] ${name} 준비 완료: ${tierStr}`);
        }

        // 4. 단 한 번의 호출로 대량 업데이트 (Upsert 방식 최적화)
        if (updateData.length > 0) {
            const { error: upsertError } = await supabase
                .from('players')
                .upsert(updateData, { onConflict: 'id' }); // id가 겹치면 업데이트

            if (upsertError) throw new Error(`Upsert Error: ${upsertError.message}`);
            console.log(`✅ 총 ${updateData.length}명의 데이터가 한 번에 갱신되었습니다.`);
        }

        return res.status(200).json({ success: true, count: updateData.length });

    } catch (error) {
        console.error("전체 에러:", error);
        return res.status(200).json({ success: false, reason: error.message });
    }
};
