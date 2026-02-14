const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw new Error(`DB Read Error: ${dbError.message}`);

        // 최적화를 위해 업데이트할 데이터를 모아서 처리
        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;

            const [name, tag] = player.riot_id.split('#');
            
            // 1. PUUID 조회
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${riotApiKey}`);
            if (!accRes.ok) continue;
            const account = await accRes.json();

            // 2. 소환사 ID 및 티어 조회 (kr 서버 기준)
            const summRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}?api_key=${riotApiKey}`);
            if (!summRes.ok) continue;
            const summoner = await summRes.json();

            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}?api_key=${riotApiKey}`);
            const leagues = await leagueRes.json();
            
            // 솔랭 데이터 찾기
            const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
            const tierStr = solo ? `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP` : "UNRANKED";

            // 3. DB 업데이트 (최적화: 개별 플레이어 정보를 즉시 반영)
            await supabase.from('players').update({ 
                tier: tierStr,
                puuid: account.puuid 
            }).eq('id', player.id);

            console.log(`${name} 업데이트 완료: ${tierStr}`);
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Critical Error:", error.message);
        return res.status(200).json({ success: false, reason: error.message });
    }
};
