import { TCloud } from 'tcloud'

const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY })

const answer = await client.ask('What is Tangle Network?')
console.log(answer)
