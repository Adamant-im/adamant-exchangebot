
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
* `passPhrase` <string> The exchanage bot's secret phrase for concluding transactions. Obligatory. Bot's ADAMANT address will correspond this passPhrase.
* `node` <string, array> List of nodes for API work, obligatorily
* `node_ETH` <string, array> List of nodes for Ethereum API work, obligatorily
* `node_LSK` <string, array> List of nodes for Lisk API work, obligatorily
* `node_DOGE` <string, array> List of nodes for Doge API work, obligatorily
* `node_BTC` <string, array> List of nodes for Bitcoin API work, obligatorily
* `node_DASH` <string, array> List of nodes for Dash API work, obligatorily
* `infoservice` <string, array> List of [ADAMANT InfoServices](https://github.com/Adamant-im/adamant-currencyinfo-services) for catching exchange rates, obligatorily
* `slack` <string> Token for Slack alerts for the bot’s administrator. No alerts if not set.
* `adamant_notify` <string> ADM address for the bot’s administrator. Recommended.
* `accepted_crypto` <string, array> List of crytpocurrencies you want to accept for exchange. If bot will receive payment in not-in-list crypto, it will try to return it. Obligatorily
* `exchange_crypto` <string, array> List of crytpocurrencies you want to send in exchange. If bot will receive request for exchange of not-in-list crypto, it will try to return payment back. Obligatorily
* `exchange_fee` <float> Pecentage you take as fee for bot's service. Default is 10.
* `exchange_fee_ADM_in` <float> Pecentage you take as fee, if receiving payment is in specific currency. This value will override general `exchange_fee`
* `min_value_usd` <float> Minimum payment equivalent in USD accepted. Default is 1.
* `daily_limit_usd` <float> Daily exchange limit for one user, equivalent in USD. Default is 1000.
* `min_confirmations` <int> Daily exchange limit for one user, equivalent in USD. Default is 3.



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


