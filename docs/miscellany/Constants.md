# Solidity API

## C

Library of constants used throughout the implementation.

_Conventions in the methods, variables and constants are as follows:

     Prefixes:

     - In constants, the prefix "Sn", where 1 <= n <= 4, denotes which slot the constant
       pertains too. There are four storage slots that are bitpacked. For example,
       "S2_OFFSET_ORACLE_TIMESTAMP" refers to the offset of the oracle timestamp in bit-
       packed storage slot 2.

     Suffixes:

     - The suffix of a variable name denotes the type contained within the variable.
       For instance "uint256 _incrementU96" is a 256-bit unsigned container representing
       the 96-bit value "_increment".
       In the case of "uint256 _balancerFeeDU1F18", the 256-bit unsigned container is
       representing a 19 digit decimal value with 18 fractional digits. In this scenario,
       the D=Decimal, U=Unsigned, F=Fractional.
       Finally, "uint128 valueU128F64" is a 128-bit container representing a 128-bit value
       with 64 fractional bits.

     - The suffix of a function name denotes what slot it is proprietary too as a
       matter of convention. While unchecked at run-time or by the compiler, the naming
       convention easily aids in understanding what slot a packed value is stored within.
       For instance the function "unpackFeeShiftS3" unpacks the fee shift from slot 3. If
       the value of slot 2 were passed to this method, the unpacked value would be
       incorrect._

### CRON_DEPLOYER_ADMIN

```solidity
address CRON_DEPLOYER_ADMIN
```

### NULL_ADDR

```solidity
address NULL_ADDR
```

### FALSE

```solidity
uint256 FALSE
```

### MAX_U256

```solidity
uint256 MAX_U256
```

### MAX_U128

```solidity
uint256 MAX_U128
```

### MAX_U112

```solidity
uint256 MAX_U112
```

### MAX_U96

```solidity
uint256 MAX_U96
```

### MAX_U64

```solidity
uint256 MAX_U64
```

### MAX_U60

```solidity
uint256 MAX_U60
```

### MAX_U32

```solidity
uint256 MAX_U32
```

### MAX_U24

```solidity
uint256 MAX_U24
```

### MAX_U20

```solidity
uint256 MAX_U20
```

### MAX_U16

```solidity
uint256 MAX_U16
```

### MAX_U10

```solidity
uint256 MAX_U10
```

### MAX_U8

```solidity
uint256 MAX_U8
```

### MAX_U3

```solidity
uint256 MAX_U3
```

### MAX_U1

```solidity
uint256 MAX_U1
```

### ONE_DU1_18

```solidity
uint256 ONE_DU1_18
```

### DENOMINATOR_DU1_18

```solidity
uint256 DENOMINATOR_DU1_18
```

### SECONDS_PER_BLOCK

```solidity
uint256 SECONDS_PER_BLOCK
```

### INDEX_TOKEN0

```solidity
uint256 INDEX_TOKEN0
```

### INDEX_TOKEN1

```solidity
uint256 INDEX_TOKEN1
```

### CLEAR_MASK_PAIR_U96

```solidity
uint256 CLEAR_MASK_PAIR_U96
```

### CLEAR_MASK_PAIR_U112

```solidity
uint256 CLEAR_MASK_PAIR_U112
```

### CLEAR_MASK_ORACLE_TIMESTAMP

```solidity
uint256 CLEAR_MASK_ORACLE_TIMESTAMP
```

### CLEAR_MASK_FEE_SHIFT

```solidity
uint256 CLEAR_MASK_FEE_SHIFT
```

### CLEAR_MASK_BALANCER_FEE

```solidity
uint256 CLEAR_MASK_BALANCER_FEE
```

### S1_OFFSET_SHORT_TERM_FEE_FP

```solidity
uint256 S1_OFFSET_SHORT_TERM_FEE_FP
```

### S1_OFFSET_PARTNER_FEE_FP

```solidity
uint256 S1_OFFSET_PARTNER_FEE_FP
```

### S1_OFFSET_LONG_TERM_FEE_FP

```solidity
uint256 S1_OFFSET_LONG_TERM_FEE_FP
```

### S2_OFFSET_ORACLE_TIMESTAMP

```solidity
uint256 S2_OFFSET_ORACLE_TIMESTAMP
```

### S3_OFFSET_FEE_SHIFT_U3

```solidity
uint256 S3_OFFSET_FEE_SHIFT_U3
```

### S4_OFFSET_PAUSE

```solidity
uint256 S4_OFFSET_PAUSE
```

### S4_OFFSET_CRON_FEE_ENABLED

```solidity
uint256 S4_OFFSET_CRON_FEE_ENABLED
```

### S4_OFFSET_COLLECT_BALANCER_FEES

```solidity
uint256 S4_OFFSET_COLLECT_BALANCER_FEES
```

### S4_OFFSET_ZERO_CRONFI_FEES

```solidity
uint256 S4_OFFSET_ZERO_CRONFI_FEES
```

### S4_OFFSET_BALANCER_FEE

```solidity
uint256 S4_OFFSET_BALANCER_FEE
```

### MAX_DECIMALS

```solidity
uint256 MAX_DECIMALS
```

### MIN_DECIMALS

```solidity
uint256 MIN_DECIMALS
```

### MINIMUM_LIQUIDITY

```solidity
uint256 MINIMUM_LIQUIDITY
```

### STABLE_OBI

```solidity
uint16 STABLE_OBI
```

### LIQUID_OBI

```solidity
uint16 LIQUID_OBI
```

### VOLATILE_OBI

```solidity
uint16 VOLATILE_OBI
```

### STABLE_MAX_INTERVALS

```solidity
uint24 STABLE_MAX_INTERVALS
```

### LIQUID_MAX_INTERVALS

```solidity
uint24 LIQUID_MAX_INTERVALS
```

### VOLATILE_MAX_INTERVALS

```solidity
uint24 VOLATILE_MAX_INTERVALS
```

### TOTAL_FP

```solidity
uint256 TOTAL_FP
```

### MAX_FEE_FP

```solidity
uint256 MAX_FEE_FP
```

### STABLE_ST_FEE_FP

```solidity
uint16 STABLE_ST_FEE_FP
```

### LIQUID_ST_FEE_FP

```solidity
uint16 LIQUID_ST_FEE_FP
```

### VOLATILE_ST_FEE_FP

```solidity
uint16 VOLATILE_ST_FEE_FP
```

### STABLE_ST_PARTNER_FEE_FP

```solidity
uint16 STABLE_ST_PARTNER_FEE_FP
```

### LIQUID_ST_PARTNER_FEE_FP

```solidity
uint16 LIQUID_ST_PARTNER_FEE_FP
```

### VOLATILE_ST_PARTNER_FEE_FP

```solidity
uint16 VOLATILE_ST_PARTNER_FEE_FP
```

### STABLE_LT_FEE_FP

```solidity
uint16 STABLE_LT_FEE_FP
```

### LIQUID_LT_FEE_FP

```solidity
uint16 LIQUID_LT_FEE_FP
```

### VOLATILE_LT_FEE_FP

```solidity
uint16 VOLATILE_LT_FEE_FP
```

### DEFAULT_FEE_SHIFT

```solidity
uint8 DEFAULT_FEE_SHIFT
```

