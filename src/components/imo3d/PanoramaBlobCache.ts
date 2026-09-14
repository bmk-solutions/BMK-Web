/** Compressed images survive GPU texture eviction without retaining decoded pixels. */
export class PanoramaBlobCache {
  private entries=new Map<string,Blob>();
  private bytes=0;
  constructor(private readonly budget:number){}
  get(key:string){const value=this.entries.get(key);if(value){this.entries.delete(key);this.entries.set(key,value);}return value;}
  set(key:string,value:Blob){
    const previous=this.entries.get(key);if(previous){this.bytes-=previous.size;this.entries.delete(key);}
    if(value.size>this.budget)return;
    this.entries.set(key,value);this.bytes+=value.size;
    while(this.bytes>this.budget){const oldest=this.entries.keys().next().value!;this.bytes-=this.entries.get(oldest)!.size;this.entries.delete(oldest);}
  }
  clear(){this.entries.clear();this.bytes=0;}
}
