const express = require('express');
const Moralis = require('moralis').default;
const router = express.Router();
// Use the moralisWatcher instance that has the loaded wallets
const watcher = require('../services/moralisWatcher');

// Middleware to verify Moralis webhook signatures
const verifyMoralisSignature = async (req, res, next) => {
  try {
    const signature = req.headers['x-signature'];
    if (!signature) {
      console.error('Missing signature header');
      return res.status(401).json({ error: 'Missing signature header' });
    }

    // Verify the signature using your webhook secret
    const webhookSecret = process.env.MORALIS_WEBHOOK_SECRET;
    const isValid = await Moralis.Streams.verifySignature({
      body: req.body,
      signature,
      webhookSecret
    });

    if (!isValid) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  } catch (error) {
    console.error('Error verifying webhook signature:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Handle webhook events from Moralis
router.post('/moralis', async (req, res) => {
  try {
    // Log the request body
    console.log('Received webhook from Moralis:', req.body);
    
    // Check if this is a verification request
    if (req.body.verified === false || req.body.tag === 'verification') {
      console.log('Received verification request from Moralis');
      // Immediately respond with 200 for verification requests
      return res.status(200).send('Webhook verification successful');
    }
    
    // For actual webhook events, verify the signature
    const signature = req.headers['x-signature'];
    if (signature && process.env.MORALIS_WEBHOOK_SECRET) {
      try {
        const isValid = await Moralis.Streams.verifySignature({
          body: req.body,
          signature,
          webhookSecret: process.env.MORALIS_WEBHOOK_SECRET
        });
        
        if (!isValid) {
          console.error('Invalid webhook signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } catch (error) {
        console.error('Error verifying webhook signature:', error);
      }
    }
    
    // Immediately respond to Moralis to acknowledge receipt
    res.status(200).send('Webhook received');
    
    // Process the webhook data asynchronously
    if (req.body.streamId) {
      processWebhookData(req.body).catch(error => {
        console.error('Error processing webhook data:', error);
      });
    }
  } catch (error) {
    console.error('Error handling Moralis webhook:', error);
    // If we haven't sent a response yet, send one now
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Process webhook data asynchronously
async function processWebhookData(webhookData) {
  try {
    // Get our token addresses from env for filtering
    const usdcAddress = (process.env.USDC_CONTRACT_ADDRESS || '').toLowerCase();
    const wethAddress = (process.env.WETH_CONTRACT_ADDRESS || '').toLowerCase();
    
    console.log(`Processing webhook data for stream: ${webhookData.streamId}`);
    console.log(`Current tokens being monitored: USDC (${usdcAddress}), WETH (${wethAddress})`);
    
    // Log the first 500 chars of the webhook data to avoid console flooding
    const webhookDataString = JSON.stringify(webhookData);
    console.log('Received webhook data (truncated):', webhookDataString.substring(0, 500) + (webhookDataString.length > 500 ? '...' : ''));
    
    // IMPORTANT: Capture ALL logs and events, then filter locally
    // -------------- Process Contract Logs (for ERC20 Transfers) --------------
    const logs = webhookData.logs || [];
    for (const log of logs) {
      try {
        // Check if this is an ERC20 Transfer event (topic0 = Transfer event signature)
        if (log.topic0 === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
          // For Transfer events, topic1 = from address, topic2 = to address (both padded with zeros)
          // We need to remove the padding
          const from = '0x' + log.topic1.slice(26).toLowerCase();
          const to = '0x' + log.topic2.slice(26).toLowerCase();
          const tokenAddress = log.address.toLowerCase();
          
          // Safely convert the log data to BigInt, handling '0x' empty values
          let value;
          try {
            const hexData = log.data || '0x0';
            // If it's just '0x', treat it as zero
            const cleanedData = hexData === '0x' ? '0x0' : hexData;
            value = BigInt(cleanedData);
          } catch (e) {
            console.warn(`Failed to convert log data to BigInt: ${log.data} - using 0`, e);
            value = BigInt(0);
          }
          
          const txHash = log.transactionHash;
          
          // Get timestamp from block data if available
          let timestamp = Math.floor(Date.now() / 1000); // Default to current time
          if (webhookData.block && webhookData.block.timestamp) {
            timestamp = parseInt(webhookData.block.timestamp);
          }
          
          console.log(`Found ERC20 transfer: ${from} -> ${to}, Token: ${tokenAddress}, Value: ${value}`);
          
          // Check if this is a token we care about (USDC or WETH for now)
          // IMPORTANT: The filter happens HERE, making it easy to add more tokens
          if (tokenAddress === usdcAddress || tokenAddress === wethAddress) {
            console.log(`Processing transfer for monitored token: ${tokenAddress}`);
            await watcher.processERC20Transfer(
              tokenAddress, 
              from, 
              to, 
              value, 
              txHash,
              timestamp
            );
          } else {
            console.log(`Ignoring transfer for non-monitored token: ${tokenAddress}`);
          }
        }
      } catch (error) {
        console.error('Error processing log event from webhook:', error);
      }
    }
    
    // -------------- Process ERC20 Transfers from erc20Transfers Field --------------
    const erc20Transfers = webhookData.erc20Transfers || [];
    if (erc20Transfers.length > 0) {
      console.log(`Processing ${erc20Transfers.length} ERC20 transfers from webhook data`);
    }
    
    for (const transfer of erc20Transfers) {
      try {
        // Normalize the fields to handle different Moralis data formats
        const tokenAddress = (transfer.contract || transfer.address || '').toLowerCase();
        const from = (transfer.from || '').toLowerCase();
        const to = (transfer.to || '').toLowerCase();
        const value = transfer.value || transfer.amount || '0';
        const txHash = transfer.transactionHash || transfer.transaction_hash;
        
        // Get timestamp from block data if available
        let timestamp = Math.floor(Date.now() / 1000); // Default to current time
        if (webhookData.block && webhookData.block.timestamp) {
          timestamp = parseInt(webhookData.block.timestamp);
        }
        
        // Check if this is a token we care about (USDC or WETH for now)
        // IMPORTANT: The filter happens HERE, making it easy to add more tokens
        if (tokenAddress === usdcAddress || tokenAddress === wethAddress) {
          console.log(`Processing ERC20 transfer: ${from} -> ${to}, Token: ${tokenAddress}, Value: ${value}`);
          
          // Process the transfer if we have all required data
          if (tokenAddress && from && to) {
            await watcher.processERC20Transfer(
              tokenAddress, 
              from, 
              to, 
              BigInt(value || '0'), 
              txHash,
              timestamp
            );
          } else {
            console.warn('Skipping ERC20 transfer with missing data:', transfer);
          }
        } else if (tokenAddress) {
          console.log(`Ignoring transfer for non-monitored token: ${tokenAddress}`);
        }
      } catch (error) {
        console.error('Error processing ERC20 transfer from webhook:', error);
      }
    }
    
    // -------------- Process Native ETH Transfers --------------
    const nativeTransfers = webhookData.txs || [];
    if (nativeTransfers.length > 0) {
      console.log(`Processing ${nativeTransfers.length} native transfers from webhook data`);
    }
    
    for (const tx of nativeTransfers) {
      try {
        // Normalize field names to handle different Moralis data formats
        const txHash = tx.hash || tx.transaction_hash;
        const from = (tx.fromAddress || tx.from || '').toLowerCase();
        const to = (tx.toAddress || tx.to || '').toLowerCase();
        const value = tx.value || '0';
        
        // Get timestamp from block data
        let timestamp = Math.floor(Date.now() / 1000); // Default to current time
        if (webhookData.block && webhookData.block.timestamp) {
          timestamp = parseInt(webhookData.block.timestamp);
        }
        
        console.log(`Processing native transfer: ${from} -> ${to}, Value: ${value}`);
        
        // Process the transaction if it has all required data
        if (from && to) {
          // Format the transaction object to match what watcher.checkTransaction expects
          const formattedTx = {
            hash: txHash,
            from: from,
            to: to,
            value: BigInt(value || '0')
          };
          
          // Native ETH transfers are always processed (no filtering needed)
          await watcher.checkTransaction(formattedTx, timestamp);
        } else {
          console.warn('Skipping native transfer with missing data:', tx);
        }
      } catch (error) {
        console.error('Error processing native transfer from webhook:', error);
      }
    }
    
    // -------------- Process Any Other Transaction Data Formats --------------
    // This is a fallback to catch any transactions that might be in a different structure
    if (webhookData.transaction || webhookData.tx) {
      try {
        const tx = webhookData.transaction || webhookData.tx;
        if (tx) {
          const txHash = tx.hash || tx.transaction_hash;
          const from = (tx.from_address || tx.from || '').toLowerCase();
          const to = (tx.to_address || tx.to || '').toLowerCase();
          const value = tx.value || '0';
          
          console.log(`Processing transaction from webhook: ${from} -> ${to}, Value: ${value}`);
          
          if (from && to) {
            const formattedTx = {
              hash: txHash,
              from: from,
              to: to,
              value: BigInt(value)
            };
            
            // Native ETH transfers are always processed (no filtering needed)
            await watcher.checkTransaction(formattedTx, Math.floor(Date.now() / 1000));
          }
        }
      } catch (error) {
        console.error('Error processing transaction from webhook:', error);
      }
    }
    
    // -------------- Process Decoded Events --------------
    // Some Moralis webhook data includes decoded events
    const decodedLogs = webhookData.decodedLogs || [];
    for (const decoded of decodedLogs) {
      try {
        // Check if this is a Transfer event
        if (decoded.name === 'Transfer') {
          const params = decoded.params || [];
          const fromParam = params.find(p => p.name === 'from');
          const toParam = params.find(p => p.name === 'to');
          const valueParam = params.find(p => p.name === 'value');
          
          if (fromParam && toParam && valueParam) {
            const from = fromParam.value.toLowerCase();
            const to = toParam.value.toLowerCase();
            const value = valueParam.value;
            const tokenAddress = (decoded.address || '').toLowerCase();
            const txHash = decoded.transactionHash;
            
            console.log(`Found decoded Transfer: ${from} -> ${to}, Token: ${tokenAddress}, Value: ${value}`);
            
            // Check if this is a token we care about
            if (tokenAddress === usdcAddress || tokenAddress === wethAddress) {
              await watcher.processERC20Transfer(
                tokenAddress,
                from,
                to,
                BigInt(value || '0'),
                txHash,
                Math.floor(Date.now() / 1000)
              );
            }
          }
        }
      } catch (error) {
        console.error('Error processing decoded log from webhook:', error);
      }
    }
  } catch (error) {
    console.error('Error processing webhook data:', error);
  }
}

module.exports = {
  router,
  processWebhookData
};
