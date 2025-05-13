const axios = require('axios');
require('dotenv').config();

class PriceFeed {
  constructor() {
    this.etherPrice = null;
    this.lastUpdate = 0;
    this.updateInterval = 1 * 60 * 1000; // Update price every 1 minute
    this.isUpdating = false;
  }

  async init() {
    await this.updateEtherPrice();
    // Set up interval to periodically update price
    setInterval(() => this.updateEtherPrice(), this.updateInterval);
    console.log('Price feed initialized successfully');
  }

  async updateEtherPrice() {
    if (this.isUpdating) return;
    
    this.isUpdating = true;
    try {
      // Use CoinGecko API to get ETH price in USD
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
      
      if (response.data && response.data.ethereum && response.data.ethereum.usd) {
        const newPrice = response.data.ethereum.usd;
        this.etherPrice = newPrice;
        this.lastUpdate = Date.now();
        console.log(`Updated ETH price: $${newPrice}`);
      } else {
        console.error('Failed to get valid price data from CoinGecko');
      }
    } catch (error) {
      console.error('Error updating ETH price:', error.message);
      
      // Fallback to another API if CoinGecko fails
      try {
        const response = await axios.get('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD');
        
        if (response.data && response.data.USD) {
          const newPrice = response.data.USD;
          this.etherPrice = newPrice;
          this.lastUpdate = Date.now();
          console.log(`Updated ETH price from fallback: $${newPrice}`);
        } else {
          console.error('Failed to get valid price data from fallback API');
        }
      } catch (fallbackError) {
        console.error('Error updating ETH price from fallback:', fallbackError.message);
      }
    } finally {
      this.isUpdating = false;
    }
  }

  // Get current ETH price in USD
  getEtherPrice() {
    // Force update if price is stale (older than 3 minutes)
    if (!this.etherPrice || (Date.now() - this.lastUpdate > 3 * 60 * 1000)) {
      console.log('Price data is stale, forcing update...');
      this.updateEtherPrice();
    }
    
    return this.etherPrice || 3000; // Default fallback value if everything fails
  }

  // Convert ETH amount to equivalent USDC amount (6 decimals)
  convertEthToUsdc(ethAmount) {
    if (!ethAmount) return 0n;
    
    try {
      // Get current ETH price
      const ethPrice = this.getEtherPrice();
      
      // Convert from Wei to ETH
      const ethValue = Number(ethAmount) / 1e18;
      
      // Calculate USD value
      const usdValue = ethValue * ethPrice;
      
      // Convert to USDC with 6 decimals
      const usdcAmount = BigInt(Math.floor(usdValue * 1e6));
      
      return usdcAmount;
    } catch (error) {
      console.error('Error converting ETH to USDC:', error.message);
      // Default fallback calculation if conversion fails
      return (ethAmount * BigInt(2000)) / BigInt(1e12); // Assuming $3000 per ETH and adjusting decimals
    }
  }
}

module.exports = new PriceFeed();
