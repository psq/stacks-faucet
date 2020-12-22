require('dotenv').config()
const express = require('express')
const { broadcastTransaction, makeSTXTokenTransfer, StacksTestnet } = require('@blockstack/stacks-transactions')
const BN = require('bn.js')
const fetch = require('node-fetch')
const Database = require('better-sqlite3')
const c32 = require('c32check')

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

function GetStacksTestnetNetwork(mode) {
  const stacksNetwork = new StacksTestnet()
  stacksNetwork.coreApiUrl = process.env[`URL_${mode}`]
  console.log("GetStacksTestnetNetwork", mode, stacksNetwork)
  return stacksNetwork
}

async function sendTransaction(serialized_tx) {
  const result = await fetch(`${process.env.URL}/v2/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: serialized_tx,
  })
  console.log("serialized_tx", serialized_tx)
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

  console.log("serialized_tx", serialized_tx, tx)

  // const result = await sendTransaction(serialized_tx)
  const result = await broadcastTransaction(tx, network)
  console.log("result", result)

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

app.get('/main-check', async (req, res) => {
  const address = req.query.address
  const testnet = 26 // 21 not P2PKH
  const mainnet = 22 // 20 not P2PKH

  const main_address = c32.c32addressDecode(address)
  // console.log("main_address", main_address)

  if (main_address[0] === mainnet) {
    const test_stx = c32.c32address(testnet, main_address[1])
    console.log("test_stx", test_stx, c32.c32ToB58(test_stx), c32.c32ToB58(address))
    const result = await fetch(`http://xenon.blockstack.org:20443/v2/accounts/${test_stx}?proof=0`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    console.log("result", result)
    if (result.ok) {
      const text = JSON.parse(await result.text())
      res.json({
        ok: {
    host: "xenon.blockstack.org:20443",
    "main-address": address,
    "test-address": test_stx,
    "main-btc": c32.c32ToB58(address),
    "test-btc": c32.c32ToB58(test_stx),
    "balance-raw": text,
    balance: parseInt(text.balance, 16) / 1000000,
    locked: parseInt(text.locked, 16) / 1000000,
        }
      })
    } else {
      throw new Error(`stacks node error: "${result.statusText}"`)
    }
  } else {
    console.log("address format not supported")
    res.json({
      error: 'format not supported',
    })
  }

})

app.get('/faucet', async (req, res) => {
  const address = req.query.address
  const stx_amount = 85_000_000_000_000
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
  const private_key = process.env.SECRET_KEY
  const network = GetStacksTestnetNetwork(req.query.mode||'KRYPTON')

  try {
    const previous_requests = findRequests(ip, address, Date.now() - 1000 * 60 * 3)
    if (previous_requests.length > 2) {
      console.log(`${Date.now()} ${ip} ${address} ${stx_amount} Too many requests`)
      return res.status(429).json({
          error: 'Too many requests',
          success: false,
        });

    }
 
    console.log("calling faucet", private_key, address, stx_amount, nonce)
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
