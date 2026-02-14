const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);

    if (!riotApiKey) {
        return res.status(200).json({ success: false, reason: "RIOT_API_KEY 미설정" });
    }

    try {
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw new Error(`DB Read Error: ${dbError.message}`);

        const tierNames = {
            'CHALLENGER': '챌린저', 'GRANDMASTER': '그랜드마스터', 'MASTER': '마스터',
            'DIAMOND': '다이아몬드', 'EMERALD': '에메랄드', 'PLATINUM': '플래티넘',
            'GOLD': '골드', 'SILVER': '실버', 'BRONZE': '브론즈', 'IRON': '아이언'
        };

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;

            const [name, tag] = player.riot_id.split('#');
            
            // 1. PUUID 조회
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotApiKey}`);
            if (!accRes.ok) continue;
            const account = await accRes.json();

            // 2. Summoner ID 조회
            const summRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}?api_key=${riotApiKey}`);
            if (!summRes.ok) continue;
            const summoner = await summRes.json();

            // 3. 티어 조회
            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}?api_key=${riotApiKey}`);
            const leagues = await leagueRes.json();
            
            let tierStr = "언랭크";
            if (Array.isArray(leagues)) {
                const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
                if (solo) {
                    const isHigh = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
                    const tierKor = tierNames[solo.tier] || solo.tier;
                    // 관리자 패널의 형식 "다이아몬드 3 - 45LP" 스타일로 저장
                    tierStr = `${tierKor}${isHigh ? '' : ' ' + solo.rank} - ${solo.leaguePoints}LP`;
                }
            }

            // [최적화] 변경된 티어와 PUUID만 업데이트
            await supabase.from('players').update({ 
                tier: tierStr,
                puuid: account.puuid 
            }).eq('id', player.id);

            console.log(`${name} 갱신 완료: ${tierStr}`);
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(200).json({ success: false, reason: error.message });
    }
};
