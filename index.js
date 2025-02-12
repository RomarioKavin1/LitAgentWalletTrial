import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LitContracts } from "@lit-protocol/contracts-sdk";
import { ethers } from "ethers";
import {
  AUTH_METHOD_SCOPE,
  AUTH_METHOD_TYPE,
  LIT_NETWORK,
  LIT_ABILITY,
} from "@lit-protocol/constants";
import {
  createSiweMessage,
  generateAuthSig,
  LitActionResource,
} from "@lit-protocol/auth-helpers";
import dotenv from "dotenv";

dotenv.config();

class BasicAgentWallet {
  constructor() {
    this.litNodeClient = new LitNodeClient({
      litNetwork: LIT_NETWORK.Datil,
      debug: true,
    });
    this.contracts = null;
  }

  async init() {
    try {
      // Connect to Lit Network
      await this.litNodeClient.connect();
      console.log("Connected to Lit Network");

      // Set up admin wallet with provider
      const provider = new ethers.providers.JsonRpcProvider(
        "https://chain-rpc.litprotocol.com/http"
      );
      this.adminWallet = new ethers.Wallet(
        process.env.ADMIN_PRIVATE_KEY,
        provider
      );
      console.log(
        "Admin wallet set up with address:",
        this.adminWallet.address
      );

      // Initialize contracts
      this.contracts = new LitContracts({
        signer: this.adminWallet,
      });
      await this.contracts.connect();
      console.log("Connected to contracts");
    } catch (err) {
      console.error("Error in initialization:", err);
      throw err;
    }
  }

  async getSessionSigs() {
    const nonce = await this.litNodeClient.getLatestBlockhash();

    const sessionSigs = await this.litNodeClient.getSessionSigs({
      chain: "ethereum",
      expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), // 24 hours
      resourceAbilityRequests: [
        {
          resource: new LitActionResource("*"),
          ability: LIT_ABILITY.LitActionExecution,
        },
      ],
      authNeededCallback: async ({
        resourceAbilityRequests,
        expiration,
        uri,
      }) => {
        const toSign = await createSiweMessage({
          uri: uri || "localhost",
          expiration,
          resources: resourceAbilityRequests,
          walletAddress: await this.adminWallet.getAddress(),
          nonce,
          litNodeClient: this.litNodeClient,
        });

        return await generateAuthSig({
          signer: this.adminWallet,
          toSign,
        });
      },
    });

    return sessionSigs;
  }

  async createWallet() {
    try {
      console.log("Preparing to mint PKP...");

      // Get session signatures
      const sessionSigs = await this.getSessionSigs();
      console.log("Got session signatures");

      // Create auth signature
      const adminAddress = await this.adminWallet.getAddress();
      const messageToSign = `I am creating a PKP for address ${adminAddress} at ${new Date().toISOString()}`;
      const signature = await this.adminWallet.signMessage(messageToSign);

      const authSig = {
        sig: signature,
        derivedVia: "web3.eth.personal.sign",
        signedMessage: messageToSign,
        address: adminAddress.toLowerCase(),
      };

      // Set up auth method
      const authMethod = {
        authMethodType: AUTH_METHOD_TYPE.EthWallet,
        accessToken: JSON.stringify(authSig),
      };

      // Get mint cost
      const mintCost = await this.contracts.pkpNftContract.read.mintCost();
      console.log("Mint cost:", ethers.utils.formatEther(mintCost), "ETH");

      console.log("Minting PKP with auth method...");
      const mintInfo = await this.contracts.mintWithAuth({
        authMethod,
        scopes: [
          AUTH_METHOD_SCOPE.SignAnything,
          AUTH_METHOD_SCOPE.PersonalSign,
        ],
        value: mintCost,
        gasLimit: ethers.BigNumber.from("1000000"),
      });

      console.log("PKP minted! Transaction hash:", mintInfo.tx.transactionHash);

      return {
        pkp: mintInfo.pkp,
        tx: mintInfo.tx,
        sessionSigs,
      };
    } catch (err) {
      console.error("Error creating wallet:", err);
      if (err.error?.error?.message) {
        console.error("RPC Error:", err.error.error.message);
      }
      throw err;
    }
  }

  async addDelegatee(mintInfo, delegateeAddress) {
    try {
      console.log("Adding delegatee...");

      const tx =
        await this.contracts.pkpPermissionsContract.write.addPermittedAddress(
          mintInfo.pkp.tokenId,
          delegateeAddress,
          [ethers.BigNumber.from(1)], // SignAnything permission
          {
            gasLimit: ethers.BigNumber.from("1000000"),
            gasPrice: ethers.utils.parseUnits("1", "gwei"),
          }
        );

      console.log("Add delegatee transaction sent:", tx.hash);
      await tx.wait();
      console.log("Successfully added delegatee:", delegateeAddress);
    } catch (err) {
      console.error("Error adding delegatee:", err);
      throw err;
    }
  }

  async signMessage(mintInfo, message) {
    try {
      const toSign = ethers.utils.arrayify(
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes(message))
      );

      const litActionCode = `
        (async () => {
          const sigShare = await LitActions.signEcdsa({
            toSign,
            publicKey,
            sigName: "sig1"
          });
        })();
      `;

      const result = await this.litNodeClient.executeJs({
        code: litActionCode,
        sessionSigs: mintInfo.sessionSigs,
        jsParams: {
          toSign,
          publicKey: mintInfo.pkp.publicKey,
        },
      });

      return result.signatures.sig1;
    } catch (err) {
      console.error("Error signing message:", err);
      throw err;
    }
  }
}

async function main() {
  const agentWallet = new BasicAgentWallet();

  try {
    // Initialize
    await agentWallet.init();
    console.log("Initialized agent wallet");

    // Create a new wallet (PKP)
    const mintInfo = await agentWallet.createWallet();
    console.log("Created PKP:", {
      tokenId: mintInfo.pkp.tokenId.toString(),
      publicKey: mintInfo.pkp.publicKey,
      ethAddress: mintInfo.pkp.ethAddress,
      transactionHash: mintInfo.tx.transactionHash,
    });

    // Test signing
    const signature = await agentWallet.signMessage(
      mintInfo,
      "Hello Lit Protocol!"
    );
    console.log("Test signature:", signature);

    // Add a delegatee
    const delegateeAddress = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
    await agentWallet.addDelegatee(mintInfo, delegateeAddress);
  } catch (error) {
    console.error("Error in main:", error);
  }
}

main();
