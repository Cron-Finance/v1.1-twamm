/**
 * IMPORTANT: Test Philosophy for this Safety Regression
 * 
 * All comparison to values in the pool should be calculated independently from the pool's values and
 * functions to ensure an independent confirmation of results and results within tolerances specified.
 * 
 * This is accomplished by using the PoolModel class, which provides a lightweight model of the pool
 * values and basic operations (i.e. CPAMM arithmetic based verification of isolated single sided LT swaps).
 * 
 * IMPORTANT: These tests are meant to be run in order. Do not change their order or results may
 *            become invalid / incorrect.
 *
 */
import { expect } from "chai"

import { ethers, waffle } from "hardhat"
import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers";

import { SwapObjects } from "./helpers/types"
import { clearNextOrderId,
         Swap,
         SwapManager,
         VaultTwammPoolAPIHelper} from "./helpers/vaultTwammPoolAPIHelper"
import { PoolModel } from "./model_v2/vaultTwammPool"
import { LTSwapParams } from "./model_v1/types"
import { scaleUp,
         getLastBlockNumber,
         mineBlocks,
         getTradeBlocks } from "./helpers/misc"      

import { deployCommonContracts } from './common';

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-delegate");

const NULL_ADDR = "0x0000000000000000000000000000000000000000";

// Equal initial liquidity for both token 0 & 1 of 10k tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;
const INITIAL_LIQUIDITY_0 = scaleUp(10_000_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(10_000_000n, TOKEN1_DECIMALS);


describe("Cron-Fi TWAMM DAO and Delegate LT Swap Role Tests", function ()
{
  let owner: SignerWithAddress,
      addr1: SignerWithAddress,
      DAO: SignerWithAddress,
      delegate: SignerWithAddress,
      admin1: SignerWithAddress,
      admin2: SignerWithAddress,
      partnerBloxRoute: SignerWithAddress,
      partnerX: SignerWithAddress,
      arbitrageur1: SignerWithAddress,
      arbitrageur2: SignerWithAddress,
      arbitrageur3: SignerWithAddress,
      arbitrageur4: SignerWithAddress,
      arbitrageur5: SignerWithAddress,
      feeAddr1: SignerWithAddress,
      feeAddr2: SignerWithAddress,
      addrs: SignerWithAddress[],
      nullAddr: SignerWithAddress;

  let poolHelper: VaultTwammPoolAPIHelper;
  let swapMgr: SwapManager;

  let poolModel: PoolModel;
    
  // Contracts for testing into local vars:
  let token0AssetContract: any;
  let token1AssetContract: any;
  let balancerVaultContract: any;
  let poolContract: any;
  let arbitrageListContract: any;
  let arbitrageListContract2: any;

  let BLOCK_INTERVAL: number


  before(async function () 
  {
    clearNextOrderId()
    await createSnapshot(waffle.provider);
    const result = await deployCommonContracts();
    BLOCK_INTERVAL = result.BLOCK_INTERVAL
    owner = result.owner;
    addr1 = result.addr1
    DAO = result.addr2
    delegate = result.addr3
    admin1 = result.admin1
    admin2 = result.admin2
    partnerBloxRoute = result.partnerBloxRoute
    partnerX = result.partnerX,
    arbitrageur1 = result.arbitrageur1
    arbitrageur2 = result.arbitrageur2
    arbitrageur3 = result.arbitrageur3
    arbitrageur4 = result.arbitrageur4
    arbitrageur5 = result.arbitrageur5
    feeAddr1 = result.feeAddr1
    feeAddr2 = result.feeAddr2
    addrs = result.addrs
    poolHelper = result.poolHelper
    swapMgr = result.swapMgr
    poolModel = result.poolModel
    token0AssetContract = result.token0AssetContract
    token1AssetContract = result.token1AssetContract
    balancerVaultContract = result.balancerVaultContract
    poolContract = result.poolContract
    arbitrageListContract = result.arbitrageListContract
    arbitrageListContract2 = result.arbitrageListContract2

    nullAddr = await ethers.getSigner(NULL_ADDR);
  })

  after(function () {
    restoreSnapshot(waffle.provider);
  })

  describe("Setup", function () {
    it ("should join / mint initial liquidity", async function () {
      await token0AssetContract.connect(owner).transfer(addr1.address, INITIAL_LIQUIDITY_0);
      await token1AssetContract.connect(owner).transfer(addr1.address, INITIAL_LIQUIDITY_1);
      let joinObjects = await poolHelper.getJoinObjects( INITIAL_LIQUIDITY_0, INITIAL_LIQUIDITY_1 );
      await token0AssetContract.connect(addr1).approve(balancerVaultContract.address, joinObjects.token0Amt);
      await token1AssetContract.connect(addr1).approve(balancerVaultContract.address, joinObjects.token1Amt);
      await mineBlocks();   // Mine after transfers (otherwise they get aggregated with other ops)

      //
      // Provide initial liquidity:
      await balancerVaultContract.connect(addr1).joinPool(
        poolHelper.getPoolId(),
        addr1.address,
        addr1.address,
        joinObjects.joinStruct
      )
      await mineBlocks();

      poolModel.initialMint(addr1.address, INITIAL_LIQUIDITY_0, INITIAL_LIQUIDITY_1)
    })
  })

  describe("DAO LT-Swap Role Capability Checks", function() {
    const intervals = 3
    let swap: Swap;
    let swapAmtPerBlock: BigNumber
    let swapParams: LTSwapParams
    let swapObjects: SwapObjects;
    let tradeBlocks: number;
    let orderMineBlock: number

    it ("should issue an LT swap for 1 token per block of T0 for T1", async function() {
      tradeBlocks = await getTradeBlocks(intervals)
      swapAmtPerBlock = scaleUp(1n, TOKEN0_DECIMALS)
      const swapAmt = swapAmtPerBlock.mul(tradeBlocks)

      swap = swapMgr.newSwap0To1()
      swapObjects = await swap.longTerm(swapAmt, intervals, DAO)

      // Note that swap params emmulates the state of the virtual order, but has to use the block
      // number after the order is mined or you get a mismatch
      orderMineBlock = await getLastBlockNumber()

      // Update the pool model to show the amount deposited into Balancer Vault
      swapParams = poolModel.ltSwap0To1(BLOCK_INTERVAL, orderMineBlock, swapAmt, intervals)
    })

    it ("should allow the DAO to withdraw part way through order", async function() {
      const blocksToMine = swapParams.swapLengthBlocks / 2
      await mineBlocks(blocksToMine);

      const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
      await swap.withdrawLongTerm()
      const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
      expect(afterBalT1).to.be.gt(prevBalT1)
    })
    
    it ("should allow the DAO to withdraw to another address part way through order", async function() {
      const blocksToMine = 10;
      await mineBlocks(blocksToMine);

      const prevBalT1 = await token1AssetContract.balanceOf(arbitrageur1.address)
      await swap.withdrawLongTerm(swap.getOrderId(), DAO, arbitrageur1)
      const afterBalT1 = await token1AssetContract.balanceOf(arbitrageur1.address)
      expect(afterBalT1).to.be.gt(prevBalT1)
    })
    
    it ("should allow the DAO to cancel the order", async function() {
      const blocksToMine = 10;
      await mineBlocks(blocksToMine);

      const prevBalT0 = await token0AssetContract.balanceOf(DAO.address)
      const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
      await swap.cancelLongTerm()
      const afterBalT0 = await token0AssetContract.balanceOf(DAO.address)
      const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
      expect(afterBalT0).to.be.gt(prevBalT0)
      expect(afterBalT1).to.be.gt(prevBalT1)
    })
    
    it ("should issue another LT swap for 1 token per block of T0 for T1", async function() {
      tradeBlocks = await getTradeBlocks(intervals)
      swapAmtPerBlock = scaleUp(1n, TOKEN0_DECIMALS)
      const swapAmt = swapAmtPerBlock.mul(tradeBlocks)

      swap = swapMgr.newSwap0To1()
      swapObjects = await swap.longTerm(swapAmt, intervals, DAO)

      // Note that swap params emmulates the state of the virtual order, but has to use the block
      // number after the order is mined or you get a mismatch
      orderMineBlock = await getLastBlockNumber()

      // Update the pool model to show the amount deposited into Balancer Vault
      swapParams = poolModel.ltSwap0To1(BLOCK_INTERVAL, orderMineBlock, swapAmt, intervals)
    })
    
    it ("should allow the DAO to cancel the order, sending funds to another address", async function() {
      const blocksToMine = swapParams.swapLengthBlocks / 2
      await mineBlocks(blocksToMine);

      const prevBalT0 = await token0AssetContract.balanceOf(arbitrageur2.address)
      const prevBalT1 = await token1AssetContract.balanceOf(arbitrageur2.address)
      await swap.cancelLongTerm(swap.getOrderId(), DAO, arbitrageur2)
      const afterBalT0 = await token0AssetContract.balanceOf(arbitrageur2.address)
      const afterBalT1 = await token1AssetContract.balanceOf(arbitrageur2.address)
      expect(afterBalT0).to.be.gt(prevBalT0)
      expect(afterBalT1).to.be.gt(prevBalT1)
    })
  })

  describe("Delegate LT-Swap Role Capability Checks", function() {
    const intervals = 3
    let swap: Swap;
    let swapAmtPerBlock: BigNumber
    let swapParams: LTSwapParams
    let swapObjects: SwapObjects;
    let tradeBlocks: number;
    let orderMineBlock: number

    it ("should issue an LT swap for 1 token per block of T0 for T1", async function() {
      tradeBlocks = await getTradeBlocks(intervals)
      swapAmtPerBlock = scaleUp(1n, TOKEN0_DECIMALS)
      const swapAmt = swapAmtPerBlock.mul(tradeBlocks)

      swap = swapMgr.newSwap0To1()
      swapObjects = await swap.longTerm(swapAmt, intervals, DAO, true, true, delegate)

      // Note that swap params emmulates the state of the virtual order, but has to use the block
      // number after the order is mined or you get a mismatch
      orderMineBlock = await getLastBlockNumber()

      // Update the pool model to show the amount deposited into Balancer Vault
      swapParams = poolModel.ltSwap0To1(BLOCK_INTERVAL, orderMineBlock, swapAmt, intervals)
    })

    it ("should allow the Delegate to withdraw part way through the order", async function() {
      const blocksToMine = swapParams.swapLengthBlocks / 2
      await mineBlocks(blocksToMine);

      const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
      await swap.withdrawLongTerm(swap.getOrderId(), delegate, DAO)
      const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
      expect(afterBalT1).to.be.gt(prevBalT1)
      expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
    })

    it ("should not allow the Delegate to withdraw to the Delegate address part way through the order", async function() {
      const blocksToMine = 10
      await mineBlocks(blocksToMine);
      
      const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
      await expect(swap.withdrawLongTerm(swap.getOrderId(), delegate, delegate)).to.be.revertedWith("CFI#010")
      const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
      expect(afterBalT1).to.be.eq(prevBalT1)
      expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
    })

    it ("should not allow the Delegate to withdraw to another address part way through the order", async function() {
      for (const destAddr of [owner, arbitrageur5, admin1]) {
        const blocksToMine = 10
        await mineBlocks(blocksToMine);
        
        const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
        const destPrevBalT1 = await token1AssetContract.balanceOf(destAddr.address)
        await expect(swap.withdrawLongTerm(swap.getOrderId(), delegate, destAddr)).to.be.revertedWith("CFI#010")
        const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
        const destAfterBalT1 = await token1AssetContract.balanceOf(destAddr.address)
        expect(afterBalT1).to.be.eq(prevBalT1)
        expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
        expect(destAfterBalT1).to.be.eq(destPrevBalT1)
      }
    })
    
    it ("should not allow the Delegate to cancel to the Delegate address part way through the order", async function() {
      const blocksToMine = 10
      await mineBlocks(blocksToMine);
      
      const prevBalT0 = await token1AssetContract.balanceOf(DAO.address)
      const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegatePrevBalT0 = await token1AssetContract.balanceOf(delegate.address)
      const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
      await expect(swap.cancelLongTerm(swap.getOrderId(), delegate, delegate)).to.be.revertedWith("CFI#010")
      const afterBalT0 = await token1AssetContract.balanceOf(DAO.address)
      const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegateAfterBalT0 = await token1AssetContract.balanceOf(delegate.address)
      const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
      expect(afterBalT0).to.be.eq(prevBalT0)
      expect(afterBalT1).to.be.eq(prevBalT1)
      expect(delegateAfterBalT0).to.be.eq(delegatePrevBalT0)
      expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
    })

    it ("should not allow the Delegate to cancel to another address part way through the order", async function() {
      for (const destAddr of [owner, arbitrageur5, admin1]) {
        const blocksToMine = 10
        await mineBlocks(blocksToMine);
        
        const prevBalT0 = await token1AssetContract.balanceOf(DAO.address)
        const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegatePrevBalT0 = await token1AssetContract.balanceOf(delegate.address)
        const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
        const destPrevBalT0 = await token1AssetContract.balanceOf(destAddr.address)
        const destPrevBalT1 = await token1AssetContract.balanceOf(destAddr.address)
        await expect(swap.cancelLongTerm(swap.getOrderId(), delegate, destAddr)).to.be.revertedWith("CFI#010")
        const afterBalT0 = await token1AssetContract.balanceOf(DAO.address)
        const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegateAfterBalT0 = await token1AssetContract.balanceOf(delegate.address)
        const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
        const destAfterBalT0 = await token1AssetContract.balanceOf(destAddr.address)
        const destAfterBalT1 = await token1AssetContract.balanceOf(destAddr.address)
        expect(afterBalT0).to.be.eq(prevBalT0)
        expect(afterBalT1).to.be.eq(prevBalT1)
        expect(delegateAfterBalT0).to.be.eq(delegatePrevBalT0)
        expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
        expect(destAfterBalT0).to.be.eq(destPrevBalT0)
        expect(destAfterBalT1).to.be.eq(destPrevBalT1)
      }
    })
    
    it ("should allow the Delegate to cancel part way through the order", async function() {
      const blocksToMine = 10
      await mineBlocks(blocksToMine);
      
      const prevBalT0 = await token1AssetContract.balanceOf(DAO.address)
      const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegatePrevBalT0 = await token1AssetContract.balanceOf(delegate.address)
      const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
      await swap.cancelLongTerm(swap.getOrderId(), delegate, DAO)
      const afterBalT0 = await token1AssetContract.balanceOf(DAO.address)
      const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
      const delegateAfterBalT0 = await token1AssetContract.balanceOf(delegate.address)
      const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
      expect(afterBalT0).to.be.gt(prevBalT0)
      expect(afterBalT1).to.be.gt(prevBalT1)
      expect(delegateAfterBalT0).to.be.eq(delegatePrevBalT0)
      expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
    })
  })
  
  describe("Other Address Capability Checks", function() {
    const intervals = 3
    let swap: Swap;
    let swapAmtPerBlock: BigNumber
    let swapParams: LTSwapParams
    let swapObjects: SwapObjects;
    let tradeBlocks: number;
    let orderMineBlock: number

    it ("should issue an LT swap for 1 token per block of T0 for T1", async function() {
      tradeBlocks = await getTradeBlocks(intervals)
      swapAmtPerBlock = scaleUp(1n, TOKEN0_DECIMALS)
      const swapAmt = swapAmtPerBlock.mul(tradeBlocks)

      swap = swapMgr.newSwap0To1()
      swapObjects = await swap.longTerm(swapAmt, intervals, DAO)

      // Note that swap params emmulates the state of the virtual order, but has to use the block
      // number after the order is mined or you get a mismatch
      orderMineBlock = await getLastBlockNumber()

      // Update the pool model to show the amount deposited into Balancer Vault
      swapParams = poolModel.ltSwap0To1(BLOCK_INTERVAL, orderMineBlock, swapAmt, intervals)
    })

    it ("should not allow non Delegate or DAO addresses to withdraw part way through the order", async function() {
      for (const senderAddr of [owner, arbitrageur1, admin1, nullAddr]) {
        const blocksToMine = 10
        await mineBlocks(blocksToMine);
        
        const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
        const destPrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
        await expect(swap.withdrawLongTerm(swap.getOrderId(), senderAddr, DAO)).to.be.revertedWith("CFI#008")
        const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
        const destAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
        expect(afterBalT1).to.be.eq(prevBalT1)
        expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
        expect(destAfterBalT1).to.be.eq(destPrevBalT1)
      }
    })
    
    it ("should not allow non Delegate or DAO addresses to withdraw to another address part way through the order", async function() {
      for (const senderAddr of [owner, arbitrageur1, admin1, nullAddr]) {
        for (const destAddr of [owner, arbitrageur5, delegate]) {
          const blocksToMine = 10
          await mineBlocks(blocksToMine);
          
          const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
          const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
          const destPrevBalT1 = await token1AssetContract.balanceOf(destAddr.address)
          await expect(swap.withdrawLongTerm(swap.getOrderId(), senderAddr, destAddr)).to.be.revertedWith("CFI#010")
          const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
          const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
          const destAfterBalT1 = await token1AssetContract.balanceOf(destAddr.address)
          expect(afterBalT1).to.be.eq(prevBalT1)
          expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
          expect(destAfterBalT1).to.be.eq(destPrevBalT1)
        }
      }
    })
    
    it ("should not allow non Delegate or DAO addresses to cancel part way through the order", async function() {
      for (const senderAddr of [owner, arbitrageur5, admin1, nullAddr]) {
        const blocksToMine = 10
        await mineBlocks(blocksToMine);
        
        const prevBalT0 = await token1AssetContract.balanceOf(DAO.address)
        const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegatePrevBalT0 = await token1AssetContract.balanceOf(delegate.address)
        const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
        await expect(swap.cancelLongTerm(swap.getOrderId(), senderAddr, DAO)).to.be.revertedWith("CFI#008")
        const afterBalT0 = await token1AssetContract.balanceOf(DAO.address)
        const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
        const delegateAfterBalT0 = await token1AssetContract.balanceOf(delegate.address)
        const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
        expect(afterBalT0).to.be.eq(prevBalT0)
        expect(afterBalT1).to.be.eq(prevBalT1)
        expect(delegateAfterBalT0).to.be.eq(delegatePrevBalT0)
        expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
      }
    })
    
    it ("should not allow non Delegate or DAO addresses to cancel to another address part way through the order", async function() {
      for (const senderAddr of [owner, arbitrageur5, admin1, nullAddr]) {
        for (const destAddr of [owner, arbitrageur5, delegate]) {
          const blocksToMine = 10
          await mineBlocks(blocksToMine);
          
          const prevBalT0 = await token1AssetContract.balanceOf(DAO.address)
          const prevBalT1 = await token1AssetContract.balanceOf(DAO.address)
          const delegatePrevBalT0 = await token1AssetContract.balanceOf(delegate.address)
          const delegatePrevBalT1 = await token1AssetContract.balanceOf(delegate.address)
          const destPrevBalT0 = await token1AssetContract.balanceOf(destAddr.address)
          const destPrevBalT1 = await token1AssetContract.balanceOf(destAddr.address)
          await expect(swap.cancelLongTerm(swap.getOrderId(), senderAddr, destAddr)).to.be.revertedWith("CFI#010")
          const afterBalT0 = await token1AssetContract.balanceOf(DAO.address)
          const afterBalT1 = await token1AssetContract.balanceOf(DAO.address)
          const delegateAfterBalT0 = await token1AssetContract.balanceOf(delegate.address)
          const delegateAfterBalT1 = await token1AssetContract.balanceOf(delegate.address)
          const destAfterBalT0 = await token1AssetContract.balanceOf(destAddr.address)
          const destAfterBalT1 = await token1AssetContract.balanceOf(destAddr.address)
          expect(afterBalT0).to.be.eq(prevBalT0)
          expect(afterBalT1).to.be.eq(prevBalT1)
          expect(delegateAfterBalT0).to.be.eq(delegatePrevBalT0)
          expect(delegateAfterBalT1).to.be.eq(delegatePrevBalT1)
          expect(destAfterBalT0).to.be.eq(destPrevBalT0)
          expect(destAfterBalT1).to.be.eq(destPrevBalT1)
        }
      }
    })
  })
})
