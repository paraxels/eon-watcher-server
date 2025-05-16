const cron = require('cron');
const donationService = require('../services/donation');
const seasonGoalService = require('../services/seasonGoals');

class Scheduler {
  constructor() {
    this.donationJob = null;
    this.seasonGoalJob = null;
  }
  
  // Calculate when the next donation is due based on frequency
  calculateNextDonationTime(lastDonationTimestamp, frequency) {
    const lastDonation = new Date(lastDonationTimestamp * 1000);
    let nextDonationTime = new Date(lastDonation);
    
    switch (frequency) {
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
    
    return nextDonationTime.toISOString();
  }

  startJobs() {
    // Schedule donation processing job using the cron pattern from environment variables
    this.donationJob = new cron.CronJob(
      process.env.TRANSACTION_SCHEDULE || '0 * * * *', // Default to every hour if not specified
      this.runDonationJob,
      null,
      true,
      'UTC'
    );
    
    // Schedule season goal check job (default to every 6 hours)
    this.seasonGoalJob = new cron.CronJob(
      process.env.SEASON_GOAL_SCHEDULE || '0 */6 * * *', 
      this.runSeasonGoalJob.bind(this),
      null,
      true,
      'UTC'
    );
    
    console.log(`Donation job scheduled with pattern: ${process.env.TRANSACTION_SCHEDULE || '0 * * * *'}`);
    console.log(`Season goal check job scheduled with pattern: ${process.env.SEASON_GOAL_SCHEDULE || '0 */6 * * *'}`);
    console.log('Job scheduler started');
  }

  stopJobs() {
    if (this.donationJob) {
      this.donationJob.stop();
      console.log('Donation job stopped');
    }
    
    if (this.seasonGoalJob) {
      this.seasonGoalJob.stop();
      console.log('Season goal check job stopped');
    }
  }

  async runDonationJob() {
    console.log('Running scheduled donation job...');
    try {
      const result = await donationService.processDonations();
      console.log('Donation job completed:', result);
    } catch (error) {
      console.error('Error running donation job:', error);
    }
  }
  
  // Method to manually trigger the donation job
  async triggerDonationJob() {
    console.log('Manually triggering donation job...');
    return this.runDonationJob();
  }
  
  async runSeasonGoalJob() {
    console.log('Running scheduled season goal check job...');
    try {
      const result = await seasonGoalService.updateAllSeasonGoals();
      console.log('Season goal check job completed:', result);
    } catch (error) {
      console.error('Error running season goal check job:', error);
    }
  }
  
  // Method to manually trigger the season goal check job
  async triggerSeasonGoalJob() {
    console.log('Manually triggering season goal check job...');
    return this.runSeasonGoalJob();
  }
}

module.exports = new Scheduler();
