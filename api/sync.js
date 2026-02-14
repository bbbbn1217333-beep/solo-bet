const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    // 1. 환경 변수 읽기
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const riotApiKey = process.env.RIOT_API_KEY;

    // 2. 초기 연결 설정
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        console.log("--- 동기화 프로세스 시작 ---");
        
        // 플레이어 목록 가져오기
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw new Error(`DB Read Error: ${dbError.message}`);

        for (const player of players) {
            if (!player.riot_id || !player.riot_id.includes('#')) continue;
            const [name, tag] = player.riot_id.split('#');

            // 라이엇 계정 조회
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${riotApiKey}`);
            
            if (accRes.status === 403) throw new Error("RIOT_API_KEY_EXPIRED");
            if (!accRes.ok) continue;

            const account = await accRes.json();
            
            // 전적 정보 및 티어 정보 업데이트 로직 (생략 - 이 부분에서 에러가 나도 다음 루프로 넘어가게 처리)
            console.log(`${name} 데이터 확인 완료`);
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Critical Error Detail:", error.message);
        
        // 500 에러를 피하기 위해 에러 내용을 담아 200으로 전송
        return res.status(200).json({ 
            success: false, 
            reason: error.message === "RIOT_API_KEY_EXPIRED" ? "라이엇 API 키를 갱신해주세요." : error.message 
        });
    }
};
