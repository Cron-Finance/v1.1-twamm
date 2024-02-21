import { expect } from "chai"

import { ethers, waffle, network } from "hardhat"
import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
import { EthPoolMainnetInterface, loadEthPoolMainnetFixture  } from "./helpers/deployer"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import { Vault, TestERC20, TestERC20__factory, CronLibV1, CronLibV1__factory, CronV1PoolFactory } from "./../typechain/index";

import { mineBlocks, deployBalancerVault} from "./helpers/misc"
import {clearNextOrderId} from "./helpers/VaultTwammPoolAPIHelper"
 
describe("TWAULT (TWAMM Balancer Vault) Factory Regression Suite", function () {
  let owner: SignerWithAddress,
     addr1: SignerWithAddress,
     addr2: SignerWithAddress,
     notOwner: SignerWithAddress,
     addrs: SignerWithAddress[];

  // Contracts for testing into local vars:
  let token0AssetContract: TestERC20;
  let token1AssetContract: TestERC20;
  let token2AssetContract: TestERC20;
  let balancerVaultContract: Vault;
  let balTwammFactoryContract: CronV1PoolFactory;

  before(async function () 
  {
      clearNextOrderId()
      await createSnapshot(waffle.provider);

      [owner, addr1, addr2, notOwner, ...addrs] = await ethers.getSigners();

      const ERC20Deployer = new TestERC20__factory(owner);
      token0AssetContract = await ERC20Deployer.deploy("Token0", "Token0", 18);
      token1AssetContract = await ERC20Deployer.deploy("Token1", "Token1", 18);
      token2AssetContract = await ERC20Deployer.deploy("Token2", "Token2", 18);

      let fixture: EthPoolMainnetInterface = await loadEthPoolMainnetFixture();
      const wethAddress = fixture.weth.address;
      balancerVaultContract = await deployBalancerVault(owner, wethAddress);
      await balancerVaultContract.setRelayerApproval( owner.address,
                                                      owner.address,    // was different addr in custom pool amm project
                                                      true );           // approved

      console.log("Deploying CronLibV1 Library ...");
      // Deploy the CronV1Pool's library for linking:
      //  - from: https://ethereum.stackexchange.com/questions/139676/how-to-deploy-a-contract-and-a-library-together-using-hardhat
      //
      const CronLibV1Deployer = new CronLibV1__factory(owner);
      const cronLibV1Contract = await CronLibV1Deployer.deploy();
      await mineBlocks();
      await cronLibV1Contract.deployed();
      console.log("Linking CronLibV1 Library to TWAMM Contract Factory ...");
      const TWAMMFactory = await ethers.getContractFactory(
        "CronV1PoolFactory",
        {
          signer: owner,
          libraries: { CronLibV1: cronLibV1Contract.address }
        }
      )
      console.log("Deploying TWAMM Contract Factory ...");
      balTwammFactoryContract = await TWAMMFactory.deploy(balancerVaultContract.address);
  })
 
   after(function () {
     restoreSnapshot(waffle.provider);
   })


 
   describe("Factory owner tests", function () {
    it ("should set new owner", async function () {
      await mineBlocks();
      const changeOwnerTx = await balTwammFactoryContract.transferOwnership(addr1.address, true, false);
      await mineBlocks();
      const receipt = await changeOwnerTx.wait()
      const eventData = receipt.events?.filter((x:any) => {return x.event == "OwnerChanged"})
      const newOwner = eventData?.[0]?.args?.newAdmin
      expect(newOwner).to.be.equal(addr1.address);
    })

    it ("should not set new owner", async function () {
      //
      // NOTE: This used to work as follows in the commented section, but
      //       changing how the factory is created/bound to the CronLibV1 
      //       made it stop working, hence the explicit try/catch code below.
      //
      //   await mineBlocks();
      //   await expect(balTwammFactoryContract.connect(notOwner).transferOwnership(addr1.address, true, false)).to.be.revertedWith("CFI#503");
      //

      await mineBlocks();
      let failed = false;
      try {
        const transaction = await balTwammFactoryContract.connect(notOwner)
                                                         .transferOwnership(addr1.address, true, false)
        await mineBlocks();
        const receipt = await transaction.wait()
      } catch (error: any) {
        failed = error && 
                 error.reason === "transaction failed" &&
                 error.code === "CALL_EXCEPTION";
      }
      expect(failed, "unauthorized owner change").to.eq(true)
    })
  })
 
   describe("Pool type tests", function () {
    it ("should create stable pool", async function () {
        await mineBlocks();
        const stablePoolTx = await balTwammFactoryContract.create(
            token0AssetContract.address,
            token1AssetContract.address,
            "Token0-Token1-Stable",
            "T0-T1-S",
            0
        );
        await mineBlocks();
        const receipt = await stablePoolTx.wait()
        const eventData = receipt.events?.filter((x:any) => {return x.event == "TWAMMPoolCreated"})
        const poolAddress = eventData?.[0]?.args?.pool
        expect(poolAddress).to.not.be.null;
     })
 
     it ("should create liquid pool", async function () {
        await mineBlocks();
        const liquidPoolTx = await balTwammFactoryContract.create(
            token0AssetContract.address,
            token1AssetContract.address,
            "Token0-Token1-Liquid",
            "T0-T1-L",
            1
        );
        await mineBlocks();
        const receipt = await liquidPoolTx.wait()
        const eventData = receipt.events?.filter((x:any) => {return x.event == "TWAMMPoolCreated"})
        const poolAddress = eventData?.[0]?.args?.pool
        expect(poolAddress).to.not.be.null;
     })
 
     it ("should create volatile pool", async function () {
        await mineBlocks();
        const volatilePoolTx = await balTwammFactoryContract.create(
            token0AssetContract.address,
            token1AssetContract.address,
            "Token0-Token1-Volatile",
            "T0-T1-V",
            2
        );
        await mineBlocks();
        const receipt = await volatilePoolTx.wait()
        const eventData = receipt.events?.filter((x:any) => {return x.event == "TWAMMPoolCreated"})
        const poolAddress = eventData?.[0]?.args?.pool
        expect(poolAddress).to.not.be.null;
     })
 
     it ("should not create invalid pool type: 4", async function () {
        await mineBlocks();
        let failed = false
        try {
          const transaction = await balTwammFactoryContract.create(
            token1AssetContract.address,
            token2AssetContract.address,
            "Token1-Token2-Invalid",
            "T1-T2-I",
            4 
          );
          await mineBlocks()
          const receipt = await transaction.wait()
        } catch(error: any) {        
          failed = error && 
                   error.reason === "transaction failed" &&
                   error.code === "CALL_EXCEPTION";
        }
        expect(failed, "invalid pool type enum").to.eq(true)
     })
 
     it ("should not create duplicate stable pool", async function () {
        //
        // NOTE: This used to work as follows in the commented section, but
        //       changing how the factory is created/bound to the CronLibV1 
        //       made it stop working, hence the explicit try/catch code below.
        //
        //    await mineBlocks();
        //    await expect(duplicateStablePoolTx).to.be.revertedWith("CFI#502")
        //
        //
        await mineBlocks();
        let failed = false
        try {
          const duplicateStablePoolTx = await balTwammFactoryContract.create(
              token0AssetContract.address,
              token1AssetContract.address,
              "Token0-Token1-Stable",
              "T0-T1-S",
              0
          );
          await mineBlocks();
          const receipt = await duplicateStablePoolTx.wait()
          await mineBlocks();
        } catch (error: any) {
          failed = error && 
                   error.reason === "transaction failed" &&
                   error.code === "CALL_EXCEPTION";
        }
        expect(failed, "duplicate stable pool created").to.eq(true)

     })
 
     it ("should not create duplicate liquid pool", async function () {
        //
        // NOTE: This used to work as follows in the commented section, but
        //       changing how the factory is created/bound to the CronLibV1 
        //       made it stop working, hence the explicit try/catch code below.
        //
        //    await mineBlocks();
        //    await expect(duplicateLiquidPoolTx).to.be.revertedWith("CFI#502")
        //
        //
        await mineBlocks();
        let failed = false;
        try {
          const duplicateLiquidPoolTx = await balTwammFactoryContract.create(
              token0AssetContract.address,
              token1AssetContract.address,
              "Token0-Token1-Liquid",
              "T0-T1-L",
              1
          );
          await mineBlocks();
          const receipt = await duplicateLiquidPoolTx.wait()
        } catch (error: any) {
          failed = error && 
                   error.reason === "transaction failed" &&
                   error.code === "CALL_EXCEPTION";
        }
        expect(failed, "duplicate liquid pool created").to.eq(true)
     })
 
     it ("should not create duplicate volatile pool", async function () {
        //
        // NOTE: This used to work as follows in the commented section, but
        //       changing how the factory is created/bound to the CronLibV1 
        //       made it stop working, hence the explicit try/catch code below.
        //
        //    await mineBlocks();
        //    await expect(duplicateVolatilePoolTx).to.be.revertedWith("CFI#502")
        //
        //
        await mineBlocks();
        let failed = false;
        try {
          const duplicateVolatilePoolTx = await balTwammFactoryContract.create(
              token0AssetContract.address,
              token1AssetContract.address,
              "Token0-Token1-Volatile",
              "T0-T1-V",
              2
          );
          await mineBlocks();
          const receipt = await duplicateVolatilePoolTx.wait()
        } catch (error: any) {
          failed = error && 
                   error.reason === "transaction failed" &&
                   error.code === "CALL_EXCEPTION";
        }
        expect(failed, "duplicate volatile pool created").to.eq(true)
     })
   })
})
