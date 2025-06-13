const { v4: uuidv4 } = require('uuid');

/**
 * Sends a notification to a user when they complete a season
 * @param {string} userFid - The user's Farcaster ID
 * @returns {Promise<Object>} The API response
 */
async function sendSeasonCompletionNotification(userFid) {
  try {
    const options = {
      method: 'POST',
      headers: {
        'x-api-key': process.env.NEYNAR_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target_fids: [userFid],
        notification: {
          title: "You Completed a Season 🎉",
          body: "Congrats on another successful season, open the miniapp to see your impact!",
          target_url: "https://eon-miniapp.vercel.app",
          uuid: uuidv4()
        }
      })
    };

    const response = await fetch('https://api.neynar.com/v2/farcaster/frame/notifications', options);
    const data = await response.json();
    console.log('Season completion notification sent:', data);
    return data;
  } catch (error) {
    console.error('Error sending season completion notification:', error);
    throw error;
  }
}

module.exports = {
  sendSeasonCompletionNotification
}; 