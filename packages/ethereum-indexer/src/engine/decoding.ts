import { AbiCoder, Interface, ParamType } from '@ethersproject/abi';
import { Coder, Reader, Writer } from '@ethersproject/abi/lib/coders/abstract-coder';
import { getAddress } from '@ethersproject/address';
import { hexZeroPad } from '@ethersproject/bytes';

export class AddressLowerCaseCoder extends Coder {
  constructor(localName: string) {
    super('address', 'address', localName, false);
  }

  defaultValue(): string {
    return '0x0000000000000000000000000000000000000000';
  }

  encode(writer: Writer, value: string): number {
    try {
      value = getAddress(value).toLowerCase();
    } catch (error: any) {
      this._throwError(error.message, value);
    }
    return writer.writeValue(value);
  }

  decode(reader: Reader): any {
    return hexZeroPad(reader.readValue().toHexString(), 20).toLowerCase();
  }
}

export class AbiCoderWithLowerCaseAddresses extends AbiCoder {
  _getCoder(param: ParamType): Coder {
    if (param.baseType === 'address') {
      return new AddressLowerCaseCoder(param.name);
    }
    return super._getCoder(param);
  }
}

const coder = new AbiCoderWithLowerCaseAddresses();
export class InterfaceWithLowerCaseAddresses extends Interface {
  static getAbiCoder(): AbiCoder {
    return coder;
  }
}
