
**WORK IS IN PROCESS. NOT READY TO USE YET**

ADAMANT Exchange Bot is a software that allows you to launch own exchange, anonymous, instant and convenient. Exchange bots work in ADAMANT Messenger chats directly.

Read more: [Multiple anonymous crypto exchanges on ADAMANT platform](https://medium.com/adamant-im/multiple-anonymous-crypto-exchanges-on-adamant-platform-11a607be0a9b).


# Installation
## Requirements
* Ubuntu 16 / Ubuntu 18 (other OS had not been tested)
* NodeJS v 8+ (already installed if you have a node on your machine)

## Setup
```
su - adamant
git clone https://github.com/Adamant-im/adamant-exchangebot
cd ./adamant-exchangebot
npm i
```

## Pre-launch tuning
```
nano config.json
```

Parameters:
* `node` <string, array> List of nodes for pool’s API work, obligatorily
* `address` <string> The delegate’s ADM wallet address, obligatorily
* `passPhrase` <string> The delegate’s secret phrase for concluding transactions. If absent, transfers are not available, and the pool will work in “Read only” mode as system for statistics.
* `reward_percentage` <number> The percentage of forged amount that will be sent to voters. Default: 80
* `minpayout` <number> Minimal sum for transfer in the end of payout period (in ADM). If the amount is not enough, the payment will be postponed to the next period. Default: 10
* `payoutperiod` <string> The duration of payout period (1d, 5d, 10d, 15d, 30d) counted from the first day of a month. 1d — everyday payouts. 10d — payouts every 1st, 10th, 20th days of month. Default: 10d
* `considerownvote` <boolean> Whether to consider your own vote (can you vote for the delegate for yourself). Default: false
* `maintenancewallet` <string> Wallet to transfer delegate share (100-reward_percentage) to. If the wallet is not set, this amount will remain on the delegate’s wallet.
* `slack` <string> Token for Slack alerts for the pool’s administrator. No alerts if not set.
* `adamant_notify` <string> ADM address for the pool’s administrator. Recommended.
* `port` <number> Port for connecting the web interface. The web interface is available at http://IP:port. Default: 36668

## Launching
You can start the Exchange Bot with the `node app` command, but it is recommended to use the process manager for this purpose.
```
pm2 start --name exchangebot app.js 
```

## Add Exchange Bot to cron:
```
crontab -e
```

Add string:
```
@reboot cd /home/adamant/adamant-exchangebot && pm2 start --name exchangebot app.js
```


