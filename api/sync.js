const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY; // Vercel 환경변수 확인 필수!
    const supabase = createClient(supabaseUrl, supabaseKey);

    // [최적화] API 키가 없는 경우 즉시 리턴하여 불필요한 로직 방지
    if (!riotApiKey) {
        return res.status(200).json({ success: false, reason: "Vercel 환경변수에 RIOT_API_KEY가 설정되지 않았습니다. (401 예방)" });
    }

    try {
        console.log("--- 동기화 프로세스 시작 ---");
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw new Error(`DB Read Error: ${dbError.message}`);

        for (const player of players) {
            // 수동 티어 설정이거나 라이엇 ID가 올바르지 않으면 스킵
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;

            const [name, tag] = player.riot_id.split('#');
            
            // 1. Account-v1: PUUID 조회
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${riotApiKey}`);
            
            if (accRes.status === 401) throw new Error("API_KEY_INVALID_OR_EMPTY");
            if (accRes.status === 403) throw new Error("API_KEY_EXPIRED");
            if (!accRes.ok) {
                console.error(`${name} 계정 조회 실패: ${accRes.status}`);
                continue;
            }
            const account = await accRes.json();

            // 2. Summoner-v4: Summoner ID 조회
            const summRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}?api_key=${riotApiKey}`);
            if (!summRes.ok) continue;
            const summoner = await summRes.json();

            // 3. League-v4: 티어 조회
            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}?api_key=${riotApiKey}`);
            const leagues = await leagueRes.json();
            
            let tierStr = "UNRANKED";
            if (Array.isArray(leagues)) {
                const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
                if (solo) {
                    // 마스터 이상은 단계(Rank)가 없으므로 체크 로직 추가
                    const isHighTier = ['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
                    tierStr = `${solo.tier}${isHighTier ? '' : ' ' + solo.rank} (${solo.leaguePoints}LP)`;
                }
            }

            // 4. DB 업데이트 (변경된 정보만 반영)
            // [최적화 Tip] 실시간 감시를 위해 trigger_cutscene은 백엔드 로직에 따라 조절 가능
            await supabase.from('players').update({ 
                tier: tierStr,
                puuid: account.puuid 
            }).eq('id', player.id);

            console.log(`${name} 동기화 완료: ${tierStr}`);
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Sync Error:", error.message);
        let userReason = error.message;
        if (error.message === "API_KEY_INVALID_OR_EMPTY") userReason = "라이엇 API 키가 비어있거나 설정이 잘못되었습니다. (401)";
        if (error.message === "API_KEY_EXPIRED") userReason = "라이엇 API 키가 만료되었습니다. (403)";

        return res.status(200).json({ success: false, reason: userReason });
    }
};
