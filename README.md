ADAMANT Exchange Bot is a software that allows you to launch own exchange, anonymous, instant and convenient. Exchange bots work in ADAMANT Messenger chats directly.

Read more: [Multiple anonymous crypto exchanges on ADAMANT platform](https://medium.com/adamant-im/multiple-anonymous-crypto-exchanges-on-adamant-platform-11a607be0a9b).

# Installation

## Requirements

* Ubuntu 16 / Ubuntu 18 (other OS had not been tested)
* NodeJS v 8+ (already installed if you have a node on your machine)
* MongoDB ([installation instructions](https://docs.mongodb.com/manual/tutorial/install-mongodb-on-ubuntu/))

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

Parameters: see comments in `config.json`.

## Launching

You can start the Exchange Bot with the `node app` command, but it is recommended to use the process manager for this purpose.

```
pm2 start --name exchangebot app.js
```

## Add Exchange Bot to cron

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
