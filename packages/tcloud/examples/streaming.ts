import { TCloud } from 'tcloud'

const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY })

for await (const chunk of client.askStream('Explain how decentralized AI inference works')) {
  process.stdout.write(chunk)
}
console.log()
