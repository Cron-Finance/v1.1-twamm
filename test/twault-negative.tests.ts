 import { expect } from "chai"

 import { ethers, waffle, network } from "hardhat"
 import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
 import { EthPoolMainnetInterface, loadEthPoolMainnetFixture  } from "./helpers/deployer"
 import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
 
 import { Vault, TestERC20, TestERC20__factory, CronLibV1, CronLibV1__factory, CronV1PoolFactory } from "./../typechain/index";
 import { SwapType, ExitType, JoinType, ParamType } from "../scripts/utils/contractMgmt"
 import { BigNumber, BytesLike } from "ethers";
 import { SwapKind } from "./helpers/batchSwap";

 import { scaleUp, mineBlocks, deployBalancerVault } from "./helpers/misc"
 import { VaultTwammPoolAPIHelper, clearNextOrderId} from "./helpers/vaultTwammPoolAPIHelper"

const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;
const INITIAL_LIQUIDITY_0 = scaleUp(10_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(10_000n, TOKEN1_DECIMALS);
 
describe("TWAULT Coverage Hole Negative Suite", function () {
  let owner: SignerWithAddress,
      addr1: SignerWithAddress,
      addr2: SignerWithAddress,
      notOwner: SignerWithAddress,
      addrs: SignerWithAddress[];
  let poolHelper: VaultTwammPoolAPIHelper;

  // Contracts for testing into local vars:
  let token0AssetContract: TestERC20;
  let token1AssetContract: TestERC20;
  let token2AssetContract: TestERC20;
  let balancerVaultContract: Vault;
  let balTwammFactoryContract: CronV1PoolFactory;

  let poolAddress: any;
  let lPoolContract: any;
  let poolId: any;

  let cronLibV1Contract: any;

  before(async function () 
  {
    clearNextOrderId()
    await createSnapshot(waffle.provider);

    [owner, addr1, addr2, notOwner, ...addrs] = await ethers.getSigners();

    const ERC20Deployer = new TestERC20__factory(owner);
    token0AssetContract = await ERC20Deployer.deploy("Token0", "Token0", 18);
    token1AssetContract = await ERC20Deployer.deploy("Token1", "Token1", 18);
    token2AssetContract = await ERC20Deployer.deploy("Token2", "Token2", 18);
    
    const ERC20BatchApproveAmt = ethers.utils.parseUnits( "10000000000" );    // 10B

    await mineBlocks();
    await token0AssetContract.connect(owner).mint(owner.address, INITIAL_LIQUIDITY_0);
    await token1AssetContract.connect(owner).mint(owner.address, INITIAL_LIQUIDITY_1);
    await mineBlocks();

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
    cronLibV1Contract = await CronLibV1Deployer.deploy();
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
    const eventData = receipt.events?.filter((x:any) => {return x.event == "CronV1PoolCreated"})
    poolAddress = eventData?.[0]?.args?.pool
    // console.log("POOL ADDRESS", poolAddress)

    const PoolContractFactory = await ethers.getContractFactory(
      "CronV1Pool",
      {
        signer: owner,
        libraries: { CronLibV1: cronLibV1Contract.address }
      }
    );
    lPoolContract = PoolContractFactory.attach(
      poolAddress // The deployed contract address
    );

    poolId = await lPoolContract.POOL_ID();
    // console.log("POOL ID", poolId)

    const newHoldingPeriodSec = 12     // 1 block
    const newHoldingPenaltyBP = 1000   // 1%
    await lPoolContract.connect(owner).setParameter(ParamType.HoldingPeriodSec, newHoldingPeriodSec)
    await lPoolContract.connect(owner).setParameter(ParamType.HoldingPenaltyBP, newHoldingPenaltyBP)
  })

  after(function () {
    restoreSnapshot(waffle.provider);
  })

  describe("Negative tests", function () {
    it ("invalid Join Type Test", async function () {

      await mineBlocks();

      const newHoldingPeriodSec = 12     // 1 block
      const newHoldingPenaltyBP = 1000   // 1%
      await lPoolContract.connect(owner).setParameter(ParamType.HoldingPeriodSec, newHoldingPeriodSec)
      await lPoolContract.connect(owner).setParameter(ParamType.HoldingPenaltyBP, newHoldingPenaltyBP)

      // Figure out the ratio of tokens to add to the pool, given an investment of 3k token0
      const token0 = scaleUp(1_000n, TOKEN0_DECIMALS)
      const token1 = scaleUp(1_000n, TOKEN1_DECIMALS)

      // Transfer the tokens to the customer's wallet and approve them for the vault contract:
      await token0AssetContract.connect(owner).transfer(addr1.address, token0);
      await token1AssetContract.connect(owner).transfer(addr1.address, token1);
      await token0AssetContract.connect(addr1).approve(balancerVaultContract.address, token0);
      await token1AssetContract.connect(addr1).approve(balancerVaultContract.address, token1);

      const assets = (await balancerVaultContract.getPoolTokens(poolId)).tokens
      const maxAmountsIn = (assets[0].toLowerCase() === token0AssetContract.address.toLowerCase()) ?
                          [token0, token1] :
                          [token1, token0];
      const amounts = maxAmountsIn.map((amt) => amt.toHexString());
      const zeroBN = BigNumber.from(0)
      const minAmounts = [zeroBN, zeroBN].map((amt) => amt.toHexString());
      let userData: BytesLike = ethers.utils.defaultAbiCoder.encode( ["uint256", "uint256[]", "uint256[]"], 
                                                                      [2, amounts, minAmounts] );

      let errorStr: string = ''
      let failed = false
      try {
        const receipt = await balancerVaultContract.connect(addr1).joinPool(
          poolId,
          addr1.address,
          addr1.address,
          {
            assets,
            maxAmountsIn,
            userData,
            fromInternalBalance: false
          }
        )
        await mineBlocks()
      } catch(error: any) {        
        failed = true
        errorStr = error.toString()
        // console.log('First error\n\n', error)
      }

      // const expectedErrStr = 'revert without reason string'
      // expect (errorStr.includes(expectedErrStr), `Message should be "${expectedErrStr}"`).to.eq(true)
      expect(
        failed,
        "invalid swap type enum"
      ).to.eq(true)
    })
    
    it ("invalid Swap Type Test", async function () {

      await mineBlocks();
      const PoolContractFactory = await ethers.getContractFactory(
        "CronV1Pool",
        {
          signer: owner,
          libraries: { CronLibV1: cronLibV1Contract.address }
        }
      );
      const lPoolContract = PoolContractFactory.attach(
        poolAddress // The deployed contract address
      );

      const poolId = await lPoolContract.POOL_ID();
      // console.log("POOL ID", poolId)

      const newHoldingPeriodSec = 12     // 1 block
      const newHoldingPenaltyBP = 1000   // 1%
      await lPoolContract.connect(owner).setParameter(ParamType.HoldingPeriodSec, newHoldingPeriodSec)
      await lPoolContract.connect(owner).setParameter(ParamType.HoldingPenaltyBP, newHoldingPenaltyBP)

      // Figure out the ratio of tokens to add to the pool, given an investment of 3k token0
      const token0 = scaleUp(1_000n, TOKEN0_DECIMALS)
      const token1 = scaleUp(1_000n, TOKEN1_DECIMALS)

      // Transfer the tokens to the customer's wallet and approve them for the vault contract:
      await token0AssetContract.connect(owner).transfer(addr1.address, token0);
      await token1AssetContract.connect(owner).transfer(addr1.address, token1);
      await token0AssetContract.connect(addr1).approve(balancerVaultContract.address, token0);
      await token1AssetContract.connect(addr1).approve(balancerVaultContract.address, token1);

      const assets = (await balancerVaultContract.getPoolTokens(poolId)).tokens
      const maxAmountsIn = (assets[0].toLowerCase() === token0AssetContract.address.toLowerCase()) ?
                          [token0, token1] :
                          [token1, token0];
      const amounts = maxAmountsIn.map((amt) => amt.toHexString());
      const zeroBN = BigNumber.from(0)
      const minAmounts = [zeroBN, zeroBN].map((amt) => amt.toHexString());
      let userData: BytesLike = ethers.utils.defaultAbiCoder.encode( ["uint256", "uint256[]", "uint256[]"], 
                                                                      [JoinType.Join, amounts, minAmounts] );

      await balancerVaultContract.connect(addr1).joinPool(
        poolId,
        addr1.address,
        addr1.address,
        {
          assets,
          maxAmountsIn,
          userData,
          fromInternalBalance: false
        }
      )
      await mineBlocks();

      const isAmount0 = !token0.isZero()
      const tokenInContract = (isAmount0) ? token0AssetContract : token1AssetContract;
      const tokenOutContract = (isAmount0) ? token1AssetContract : token0AssetContract;
      const tokenInAmtBeforeScale = (isAmount0) ? token0 : token1;
      const tokenDecimals = (isAmount0) ? TOKEN0_DECIMALS : TOKEN1_DECIMALS;

      const tokenInAmt = tokenInAmtBeforeScale
      userData = ethers.utils.defaultAbiCoder.encode(
        ["uint256","uint256"],
        [4, 0]
      );

      await tokenInContract.connect(owner).transfer(addr1.address, tokenInAmt)
      await tokenInContract.connect(addr1).approve(balancerVaultContract.address, tokenInAmt)
      await mineBlocks();
    
      const swapStruct = {
        poolId: poolId,
        kind: SwapKind.GIVEN_IN,
        assetIn: tokenInContract.address,
        assetOut: tokenOutContract.address,
        amount: tokenInAmt,
        userData
      }
      const fundStruct = {
        sender: addr1.address,
        fromInternalBalance: false,
        recipient: addr1.address,
        toInternalBalance: false
      }
      const limitOutAmt = 0
      const deadlineSec = Math.round(Date.now() / 1000) + 60 * 60 * 24

      let errorStr: string = ''
      let failed = false
      try {
        const receipt = await balancerVaultContract.connect(addr1).swap(
          swapStruct,
          fundStruct,
          limitOutAmt,
          deadlineSec
        )
        await mineBlocks()
      } catch(error: any) {        
        failed = true
        errorStr = error.toString()
        // console.log('First error\n\n', error)
      }

      // const expectedErrStr = 'revert without reason string'
      // expect (errorStr.includes(expectedErrStr), `Message should be "${expectedErrStr}"`).to.eq(true)
      expect(
        failed,
        "invalid swap type enum"
      ).to.eq(true)
    })

    it ("invalid exit Type Test", async function () {

      await mineBlocks();
      const PoolContractFactory = await ethers.getContractFactory(
        "CronV1Pool",
        {
          signer: owner,
          libraries: { CronLibV1: cronLibV1Contract.address }
        }
      );
      const lPoolContract = PoolContractFactory.attach(
        poolAddress // The deployed contract address
      );

      const poolId = await lPoolContract.POOL_ID();
      // console.log("POOL ID", poolId)

      const newHoldingPeriodSec = 12     // 1 block
      const newHoldingPenaltyBP = 1000   // 1%
      await lPoolContract.connect(owner).setParameter(ParamType.HoldingPeriodSec, newHoldingPeriodSec)
      await lPoolContract.connect(owner).setParameter(ParamType.HoldingPenaltyBP, newHoldingPenaltyBP)

      // Figure out the ratio of tokens to add to the pool, given an investment of 3k token0
      const token0 = scaleUp(1_000n, TOKEN0_DECIMALS)
      const token1 = scaleUp(1_000n, TOKEN1_DECIMALS)

      // Transfer the tokens to the customer's wallet and approve them for the vault contract:
      await token0AssetContract.connect(owner).transfer(addr1.address, token0);
      await token1AssetContract.connect(owner).transfer(addr1.address, token1);
      await token0AssetContract.connect(addr1).approve(balancerVaultContract.address, token0);
      await token1AssetContract.connect(addr1).approve(balancerVaultContract.address, token1);

      const assets = (await balancerVaultContract.getPoolTokens(poolId)).tokens
      const maxAmountsIn = (assets[0].toLowerCase() === token0AssetContract.address.toLowerCase()) ?
                          [token0, token1] :
                          [token1, token0];
      const amounts = maxAmountsIn.map((amt) => amt.toHexString());
      const zeroBN = BigNumber.from(0)
      const minAmounts = [zeroBN, zeroBN].map((amt) => amt.toHexString());
      let userData: BytesLike = ethers.utils.defaultAbiCoder.encode( ["uint256", "uint256[]", "uint256[]"], 
                                                                      [JoinType.Join, amounts, minAmounts] );

      await balancerVaultContract.connect(addr1).joinPool(
        poolId,
        addr1.address,
        addr1.address,
        {
          assets,
          maxAmountsIn,
          userData,
          fromInternalBalance: false
        }
      )
      await mineBlocks();

      let tokensLP = await lPoolContract.balanceOf(addr1.address)
      await lPoolContract.connect(addr1).approve(balancerVaultContract.address, tokensLP);

      const minToken0LPAmt = ethers.utils.parseUnits("0", TOKEN0_DECIMALS);
      const minToken1LPAmt = ethers.utils.parseUnits("0", TOKEN1_DECIMALS);
      const minAmountsOut = [minToken0LPAmt, minToken1LPAmt];   // Zero minimum out.
      userData = ethers.utils.defaultAbiCoder.encode(
        ["uint256","uint256"],
        [4, 0]
      );
      let toInternalBalance = false

      let errorStr: string = ''
      let failed = false
      try {
        const receipt = await balancerVaultContract.connect(addr1).exitPool(
          poolId,
          addr1.address,
          addr1.address,
          {
            assets,
            minAmountsOut,
            userData,
            toInternalBalance
          }
        )
        await mineBlocks()
      } catch(error: any) {        
        failed = true
        errorStr = error.toString()
        // console.log('First error\n\n', error)
      }

      // const expectedErrStr = 'revert without reason string'
      // expect (errorStr.includes(expectedErrStr), `Message should be "${expectedErrStr}"`).to.eq(true)
      expect(
        failed,
        "invalid exit type enum"
      ).to.eq(true)
    })
  })
})
