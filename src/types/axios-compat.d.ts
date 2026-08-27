import "axios";

declare module "axios" {
  interface AxiosInstance {
    get(url: string, config?: any): Promise<any>;
    post(url: string, data?: any, config?: any): Promise<any>;
  }

  interface AxiosStatic {
    get(url: string, config?: any): Promise<any>;
    post(url: string, data?: any, config?: any): Promise<any>;
  }
}
