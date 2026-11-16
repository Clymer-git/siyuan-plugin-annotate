/**
 * 选区识别的 Worker 入口。
 *
 * 主线程把「降采样后的整幅画面」丢进来，这里算出所有独立区块的矩形坐标，
 * 一次性回传；所有像素级计算都在这个线程里完成，界面不会卡。
 *
 * 约定：请求 {id, data, width, height}，回 {id, regions}；
 * 任何异常都回 regions = null，由主线程提示「没找到可识别的区域」。
 */
import {detectRegions, type SmartImage, type SmartRegion} from "./smartSelect";

interface SmartRequest extends SmartImage {
    id: number;
}

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<SmartRequest>) => void) | null;
    postMessage: (message: unknown) => void;
};

scope.onmessage = (event: MessageEvent<SmartRequest>) => {
    const {id, data, width, height} = event.data;
    let regions: SmartRegion[] | null = null;
    try {
        regions = detectRegions({data, width, height});
    } catch {
        regions = null;
    }
    scope.postMessage({id, regions});
};
