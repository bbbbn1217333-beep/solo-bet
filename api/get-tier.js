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
    
    if (accRes.status === 403) throw new Error('API KEY EXPIRED'); // 키 만료 시
    if (accRes.status === 404) throw new Error('ID NOT FOUND');
    
    const accData = await accRes.json();
    if (!accData.puuid) throw new Error('NO PUUID');

    // 2. Summoner-v4: Summoner ID 조회
    const sumRes = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${accData.puuid}?api_key=${RIOT_KEY}`);
    const sumData = await sumRes.json();

    // 3. League-v4: 티어 정보 조회
    const leaRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${sumData.id}?api_key=${RIOT_KEY}`);
    const leaData = await leaRes.json();

    // 솔로 랭크 데이터 추출 (RANKED_SOLO_5x5)
    const solo = leaData.find(e => e.queueType === 'RANKED_SOLO_5x5');
    
    let tierString = "UNRANKED";
    if (solo) {
      // 가독성을 위해 모두 대문자로 유지
      const hasRank = !['CHALLENGER', 'GRANDMASTER', 'MASTER'].includes(solo.tier);
      tierString = `${solo.tier}${hasRank ? ' ' + solo.rank : ''} (${solo.leaguePoints}LP)`;
    }

    // 관리자 패널에서만 호출할 것이므로 캐시를 짧게 주거나 없애도 무방합니다.
    res.setHeader('Cache-Control', 'no-store'); 
    res.status(200).json({ success: true, tier: tierString });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message.toUpperCase() });
  }
}
