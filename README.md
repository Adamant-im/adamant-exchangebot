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
* `known_crypto` <string, array> List of crytpocurrencies bot can work with. If bot will receive or request for crypto not in list, it will not process payment and notify owner. Obligatorily
* `accepted_crypto` <string, array> List of crytpocurrencies you want to accept for exchange. If bot will receive payment in not-in-list crypto, it will try to return it. Obligatorily
* `exchange_crypto` <string, array> List of crytpocurrencies you want to send in exchange. If bot will receive request for exchange of not-in-list crypto, it will try to return payment back. Obligatorily
* `exchange_fee` <float> Pecentage you take as fee for bot's service. Default is 10.
* `exchange_fee_ADM` <float> Pecentage you take as fee, if receiving payment is in specific currency. This value will override general `exchange_fee`
* `min_value_usd` <float> Minimum payment equivalent in USD accepted. Default is 1.
* `daily_limit_usd` <float> Daily exchange limit for one user, equivalent in USD. Default is 1000.
* `min_confirmations` <int> How many confirmations to wait before transaction counts accepted. Default is 3.
* `min_confirmations_ADM` <int> To override `min_confirmations` for specific cryptocurrency.
* `welcome_string` <string> How to reply user in-chat, if unknown command received. Default is “Hello 😊. I didn’t understand you. I am exchange bot, anonymous and work instant. ℹ️ Learn more about me on ADAMANT’s blog or type **/help** to see what I can.”

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

## Updating
```
su - adamant
cd ./adamant-exchangebot
pm2 stop exchangebot
mv config.json config_bup.json && git pull && mv config_bup.json config.json
npm i
pm2 start --name exchangebot app.js 
```

