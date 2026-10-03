export type BranchInput = {
  name: string;
  code: string;
  type: string;
  phone?: string;
  email?: string;
};
export type HubInput = {
  name: string;
  code: string;
  address: string;
  city: string;
  branchId?: string;
  merchantId?: string;
};
export type VehicleInput = {
  type: string;
  plateNumber: string;
  capacityKg?: number;
};
export type HubManagerInput = {
  email: string;
  password: string;
  name: string;
  hubId: string;
  branchId?: string;
};
export type RiderInput = {
  email: string;
  password: string;
  name: string;
  phone?: string;
  hubId: string;
  vehicleType?: string;
};
