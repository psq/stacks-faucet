require('dotenv').config()
const express = require('express')
const { broadcastTransaction, makeSTXTokenTransfer, StacksTestnet } = require('@blockstack/stacks-transactions')
const BN = require('bn.js')
const fetch = require('node-fetch')
const Database = require('better-sqlite3')

const db = new Database(`./faucet.db`, {
  readonly: false,
  fileMustExist: false,
})

const stmt1 = db.prepare('CREATE TABLE IF NOT EXISTS requests (ip TEXT, address DATE, txid TEXT, time INT, nonce INT)')
const info1 = stmt1.run()

const stmt_all_request = db.prepare('SELECT * FROM requests ORDER BY time')
const stmt_find_request = db.prepare('SELECT * FROM requests WHERE ip=? and address=? and time>?')
const stmt_insert_request = db.prepare('INSERT INTO requests (ip, address, txid, time, nonce) VALUES (?, ?, ?, ?, ?)')

function insertFaucetRequest(ip, address, txid, time, nonce) {
  const result = stmt_insert_request.run(ip, address, txid, time, nonce)
  // console.log("insertFaucetRequest", result)
  return result
}

function findRequests(ip, address, time) {
  const result = stmt_find_request.all(ip, address, time)
  // console.log("findRequests", result)
  return result
}

function allRequests() {
  const result = stmt_all_request.all()
  // console.log("findRequests", result)
  return result
}


const app = express()
const port = 4444
let nonce = 0

function GetStacksTestnetNetwork() {
  const stacksNetwork = new StacksTestnet()
  stacksNetwork.coreApiUrl = process.env.URL
  // console.log("GetStacksTestnetNetwork", stacksNetwork)
  return stacksNetwork
}

async function sendTransaction(serialized_tx) {
  const result = await fetch(`${process.env.URL}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: serialized_tx,
  })
  console.log("sendTransaction.result", result)
  if (result.ok) {
    const text = await result.text()
    console.log("sendTransaction.text", text)
    return JSON.parse(text)
  } else {
    throw new Error(`stacks node error: "${result.statusText}"`)
  }
}

async function faucet(network, private_key, address, stx_amount, nonce) {
  const tx = await makeSTXTokenTransfer({
    recipient: address,
    amount: new BN(stx_amount),
    senderKey: private_key,
    network,
    memo: 'Faucet-psq',
    nonce: new BN(nonce),
  })

  const tx_raw = tx.serialize().toString('hex')
  const serialized_tx = tx.serialize()

  // console.log("serialized_tx", serialized_tx, tx)

  // const result = await sendTransaction(serialized_tx)
  const result = await broadcastTransaction(tx, network)
  // console.log("result", result)

  return result
}


app.get('/report', async (req, res) => {
  const requests = allRequests()
  const count = requests.length
  res.json({
    success: true,
    count,
    requests,
  })
})

app.get('/faucet', async (req, res) => {
  const address = req.query.address
  const stx_amount = 3_000_000_000_000
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
  const private_key = process.env.SECRET_KEY
  const network = GetStacksTestnetNetwork()

  try {
    const previous_requests = findRequests(ip, address, Date.now() - 1000 * 60 * 3)
    if (previous_requests.length > 4) {
      console.log(`${Date.now()} ${ip} ${address} ${stx_amount} Too many requests`)
      return res.status(429).json({
          error: 'Too many requests',
          success: false,
        });

    }

    let result = await faucet(network, private_key, address, stx_amount, nonce)
    if (result.error && result.reason === 'BadNonce') {
      nonce = result.reason_data.expected
      result = await faucet(network, private_key, address, stx_amount, nonce)
    }
    if (result.error) {
      throw new Error(result.error)
    }

    const tx_id = `0x${result}`
    // const tx_id = '0x1234567890'

    insertFaucetRequest(ip, address, tx_id, Date.now(), nonce)
    res.json({
      success: true,
      tx_id,
    })

    nonce += 1
    console.log(`${Date.now()} ${ip} ${address} ${stx_amount} ${tx_id} ${nonce}`)
  } catch(e) {
    console.log(`${Date.now()} ${ip} ${address} ${stx_amount} ${e} ${e.message}`)
    res.json({
      success: false,
      error: e,
      message: e.message,
    })

  }
})

app.listen(port, () => {
  console.log(`listening at http://localhost:${port}`)
})

