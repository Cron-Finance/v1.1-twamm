#!/bin/bash

# To load the variables in the .env file
source .env

# To deploy and verify our contract
forge script ./contracts/twault/scripts/CronV1PoolFactory.s.sol:CronV1PoolFactoryScript --rpc-url $GOERLI_RPC_URL --broadcast --verify -vvvv