const ExistingWallet = require('../models/ExistingWallet');
const blockchainService = require('./blockchain');

class DonationService {
  async getEligibleWallets() {
    try {
      // Get all wallets with donation settings
      const walletsWithDonations = await ExistingWallet.find({ 'donationSettings.amount': { $exists: true, $ne: null } });
      console.log(`Found ${walletsWithDonations.length} wallets with donation settings`);
      
      const eligibleWallets = [];
      
      for (const wallet of walletsWithDonations) {
        try {
          // Skip wallets without proper donation settings
          if (!wallet.donationSettings || !wallet.donationSettings.recipients || 
              wallet.donationSettings.recipients.length === 0 || !wallet.donationSettings.amount) {
            continue;
          }
          
          // Check if wallet is due for donation based on frequency
          if (!this._isDonationDue(wallet)) {
            continue;
          }
          
          // Check allowance and balance
          const allowance = await blockchainService.checkAllowance(wallet.address);
          const balance = await blockchainService.checkBalance(wallet.address);
          const donationAmount = BigInt(wallet.donationSettings.amount);
          
          // Check if there's enough allowance and balance
          if (allowance >= donationAmount && balance >= donationAmount && donationAmount > 0) {
            eligibleWallets.push(wallet);
          } else {
            console.log(`Wallet ${wallet.address} ineligible: allowance=${allowance}, balance=${balance}, donationAmount=${donationAmount}`);
          }
        } catch (error) {
          console.error(`Error processing wallet ${wallet.address}:`, error);
        }
      }
      
      console.log(`Found ${eligibleWallets.length} eligible wallets for donation`);
      return eligibleWallets;
    } catch (error) {
      console.error('Error getting eligible wallets:', error);
      throw error;
    }
  }
  
  _isDonationDue(wallet) {
    const now = Date.now();
    const lastDonation = wallet.lastDonation ? wallet.lastDonation * 1000 : 0;
    
    // If no previous donation, it's due
    if (lastDonation === 0) {
      return true;
    }
    
    // Calculate the next donation time based on the frequency
    let nextDonationTime = new Date(lastDonation);
    
    switch (wallet.donationSettings.frequency) {
      case 'daily':
        nextDonationTime.setDate(nextDonationTime.getDate() + 1);
        break;
      case 'weekly':
        nextDonationTime.setDate(nextDonationTime.getDate() + 7);
        break;
      case 'monthly':
        nextDonationTime.setMonth(nextDonationTime.getMonth() + 1);
        break;
      default:
        // Default to monthly if frequency not recognized
        nextDonationTime.setMonth(nextDonationTime.getMonth() + 1);
    }
    
    return now >= nextDonationTime.getTime();
  }
  
  async processDonations() {
    try {
      const eligibleWallets = await this.getEligibleWallets();
      
      if (eligibleWallets.length === 0) {
        console.log('No eligible wallets found for donation');
        return { success: true, processedCount: 0 };
      }
      
      // Track successful and failed donations
      const donationBatch = [];
      const successfulWallets = [];
      const failedWallets = [];
      
      // Prepare donation batch
      for (const wallet of eligibleWallets) {
        try {
          // For each recipient, calculate their donation amount
          for (const recipient of wallet.donationSettings.recipients) {
            const recipientAmount = (BigInt(wallet.donationSettings.amount) * BigInt(recipient.percentage)) / BigInt(100);
            
            if (recipientAmount > 0) {
              donationBatch.push({
                from: wallet.address,
                to: recipient.address,
                amount: recipientAmount.toString()
              });
              
              // Only add wallet once to successful list
              if (!successfulWallets.includes(wallet._id)) {
                successfulWallets.push(wallet._id);
              }
            }
          }
        } catch (error) {
          console.error(`Error preparing donation for wallet ${wallet.address}:`, error);
          failedWallets.push(wallet._id);
        }
      }
      
      // Process the donations
      const result = await blockchainService.processDonations(donationBatch);
      
      if (result.success) {
        // Update the lastDonation for successful wallets
        const currentTimestamp = Math.floor(Date.now() / 1000);
        await ExistingWallet.updateMany(
          { _id: { $in: successfulWallets } },
          { $set: { lastDonation: currentTimestamp, updatedAt: new Date() } }
        );
        
        console.log(`Updated ${successfulWallets.length} wallets with new donation timestamp`);
      }
      
      return {
        success: result.success,
        processedCount: successfulWallets.length,
        failedCount: failedWallets.length,
        transactionHash: result.transactionHash
      };
    } catch (error) {
      console.error('Error processing donations:', error);
      throw error;
    }
  }
}

module.exports = new DonationService();
