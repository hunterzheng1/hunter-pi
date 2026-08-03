const values: string[] = [];
const firstValue: string = values[0];

interface OptionalValue {
  value?: string;
}

const invalidOptionalValue: OptionalValue = { value: undefined };

void firstValue;
void invalidOptionalValue;
