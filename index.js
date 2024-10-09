import express from "express";
import mongoose from "mongoose";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";

// Load environment variables from `.env` file
dotenv.config();

import { Connection } from "@solana/web3.js";
import { marketAbi } from "./blockchain/abi.js";
import { programID } from "./utils/constants.js";
import { BorshCoder } from "@project-serum/anchor";
import { CoinDecimals } from "./types/index.js";
import { paymentModel } from "./models/paymentinfo.model.js";

const app = express();

const port = process.env.PORT || 5100;

app.use(cors());
app.use(bodyParser.json());

function connectWithRetry() {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => {
      console.log("Connected to Database");
    })
    .catch((err) => {
      console.error(
        "Failed to connect to MongoDB, retrying in 5 seconds...",
        err
      );
      setTimeout(connectWithRetry, 5000);
    });
  mongoose.set("debug", process.env.NODE_ENV != "production");
}

connectWithRetry();

app.get("/", async (req, res) => {
  return res.json({ success: true });
});
app.post("/api/payment/:requestId", async (req, res) => {
  try {
    connectWithRetry();
    const { requestId, transactionHash } = req.body;
    await paymentModel.updateOne(
      { requestId: requestId },
      { transactionHash, requestId },
      { upsert: true }
    );
    return res.json({ success: true });
  } catch (error) {
    console.log("Error", error);
    return res.json({ error: error, success: false });
  }
});

app.post("/api/:requestId", async (req, res) => {
  try {
    const requestId = req.params.requestId;
    const preflightCommitment = "processed";
    const connection = new Connection(
      process.env.SOLANA_RPC_URL,
      preflightCommitment
    );
    const abiDecoder = new BorshCoder(marketAbi);
    const filter = abiDecoder.accounts.memcmp("RequestPaymentTransaction");
    const accounts = await connection.getParsedProgramAccounts(programID, {
      filters: [
        {
          dataSize: filter.dataSize,
          memcmp: {
            offset: 8 + 32,
            bytes: requestId,
          },
        },
      ],
    });

    let decodedAccount;

    for (const account of accounts) {
      try {
        decodedAccount = abiDecoder.accounts.decode(
          "RequestPaymentTransaction",
          account.account.data
        );
        break;
      } catch (e) {}
    }
    const paymentMade = await paymentModel.findOne({
      requestId: Number(decodedAccount.requestId),
    });

    if (paymentMade) {
      return paymentMade;
    }

    const tokenInfo = Object.keys(decodedAccount.token)[0];

    let tokenMint = "";

    switch (tokenInfo) {
      case "pyusdt":
        tokenMint = process.env.PY_USD_MINT;
        break;
      case "solana":
        tokenMint = process.env.SOL_MINT;
        break;
    }
    const payload = {
      to: decodedAccount.sellerAuthority.toBase58(),
      token: tokenMint,
      amount: Number(decodedAccount.amount).toString(),
    };

    const data = await fetch(
      `https://api.portalhq.io/api/v3/clients/me/chains/${process.env.SOLANA_CHAIN_ID}/assets/send/build-transaction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PORTAL_CLIENT_API_KEY}`,
        },
        body: JSON.stringify({
          to: payload.to,
          token: payload.token,
          amount: (+payload.amount / 10 ** CoinDecimals[tokenInfo]).toString(),
        }),
      }
    );

    return res.json(await data.json());
  } catch (error) {
    console.error(error);
    res.status(500).send(error.message);
  }
});

app.listen(port, () => {
  console.log(`Server is running on port http://localhost:${port}`);
});
