// api/get-tier.js
export default async function handler(req, res) {
  const { name, tag } = req.query;
  const RIOT_KEY = process.env.RIOT_API_KEY;

  if (!name || !tag) {
    return res.status(400).json({ success: false, error: "닉네임#태그를 확인해주세요." });
  }

  try {
    // 1. Account-v1: PUUID 조회
    const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${RIOT_KEY}`);
    
    if (accRes.status === 403) throw new Error('API KEY EXPIRED');
    if (accRes.status === 404) throw new Error('ID NOT FOUND');
    
    const accData = await accRes.json();
    const puuid = accData.puuid;
    if (!puuid) throw new Error('NO PUUID');

    // [추가] 2. Match-v5: 최근 게임 ID 1개 조회 (게임 종료 감지용)
    // asia 서버 주소를 사용해야 합니다.
    const matchRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1&api_key=${RIOT_KEY}`);
    const matchIds = await matchRes.json();
    const lastMatchId = (matchIds && matchIds.length > 0) ? matchIds[0] : "NO_MATCH";

    // 3. Summoner-v4: Summoner ID 조회
    const sumRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?api_key=${RIOT_KEY}`);
    const sumData = await sumRes.json();

    // 4. League-v4: 티어 정보 조회
    const leaRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${sumData.id}?api_key=${RIOT_KEY}`);
    const leaData = await leaRes.json();

    // 솔로 랭크 데이터 추출
    const solo = leaData.find(e => e.queueType === 'RANKED_SOLO_5x5');
    
    let tierString = "UNRANKED";
    if (solo) {
      const hasRank = !['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
      tierString = `${solo.tier}${hasRank ? ' ' + solo.rank : ''} (${solo.leaguePoints}LP)`;
    }

    res.setHeader('Cache-Control', 'no-store'); 
    // [수정] 티어와 함께 마지막 매치 ID를 같이 내려줍니다.
    res.status(200).json({ 
      success: true, 
      tier: tierString, 
      lastMatchId: lastMatchId 
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message.toUpperCase() });
  }
}

