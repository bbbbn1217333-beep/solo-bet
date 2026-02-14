const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        console.log("--- 동기화 프로세스 시작 ---");
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw new Error(`DB Read Error: ${dbError.message}`);

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;

            const [name, tag] = player.riot_id.split('#');
            
            // 1. PUUID 조회
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${riotApiKey}`);
            if (!accRes.ok) continue;
            const account = await accRes.json();

            // 2. 소환사 ID 조회 (kr 서버)
            const summRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}?api_key=${riotApiKey}`);
            if (!summRes.ok) continue;
            const summoner = await summRes.json();

            // 3. 티어 조회
            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}?api_key=${riotApiKey}`);
            const leagues = await leagueRes.json();
            
            // [오류 수정 포인트] leagues가 배열인지 확인하는 안전장치 추가
            let tierStr = "UNRANKED";
            if (Array.isArray(leagues)) {
                const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
                if (solo) {
                    tierStr = `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP`;
                }
            } else {
                console.error(`${player.name} 티어 정보 로드 실패 (배열 아님):`, leagues);
            }

            // 4. DB 업데이트
            await supabase.from('players').update({ 
                tier: tierStr,
                puuid: account.puuid 
            }).eq('id', player.id);

            console.log(`${name} 업데이트 완료: ${tierStr}`);
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Critical Error Detail:", error.message);
        return res.status(200).json({ 
            success: false, 
            reason: error.message 
        });
    }
};
