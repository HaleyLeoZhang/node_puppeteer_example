import BaseTask from "../../libs/Base/BaseTask";
import GuFengService from "../../services/Comic/GuFengService";
import ContextTool from "../../tools/ContextTool";
import TaskLogic from "../../logics/ComicCurl/TaskLogic";
import Log from "../../tools/Log";
import CONST_BUSINESS_COMIC from "../../constant/business_comic";
import RabbitMQ, {ACK_NO, ACK_YES, DEFAULT_PULL_TIME_SECOND, IF_EXIT_YES} from "../../libs/MQ/RabbitMQ";
import LiuManHuaService from "../../services/Comic/LiuManHuaService";
import CONST_AMQP from "../../constant/amqp";
import TimeTool from "../../tools/TimeTool";

export default class ComicTaskTest extends BaseTask {
    // ---------------------------------------------------
    // -------------------
    // 调用示例
    // node ./es5/app.js comic_test eval_script  # 拉取图片列表
    // node ./es5/app.js comic_test eval_script_2  # 拉取图片列表
    // node ./es5/app.js comic_test supplier_image
    // node ./es5/app.js comic_test supplier_base
    // node ./es5/app.js comic_test mq_timeout
    // ----------------------------------------------------------------------
    static async eval_script() {
        let ctx = ContextTool.initial() // 每次拉取都是一个新的上下文
        let url = "https://www.gufengmh8.com/manhua/bailianchengshen/1447913.html"
        let list = await GuFengService.get_image_list(ctx, url)
        console.log(list)
    }
    static async eval_script_2() {
        let ctx = ContextTool.initial() // 每次拉取都是一个新的上下文
        let url = "http://www.sixmh6.com/17128/703818.html"
        let list = await LiuManHuaService.get_image_list(ctx, url)
        console.log(list)
    }

    static async supplier_image() {
        let ctx = ContextTool.initial() // 每次拉取都是一个新的上下文
        let url = "https://www.gufengmh8.com/manhua/bailianchengshen/1447913.html"
        let payload = {
            "id": 14,
            "url": url,
        }
        await TaskLogic.supplier_image(ctx, payload)
    }
    static async supplier_base() {
        let ctx = ContextTool.initial() // 每次拉取都是一个新的上下文
        let payload = {
            "id": 14, // 渠道ID
        }
        try {
            Log.ctxInfo(ctx, 'base_supplier_consumer.start')
            let result = await TaskLogic.supplier_base(ctx, payload)
            if (result === CONST_BUSINESS_COMIC.TASK_FAILED) {
                throw new Error("TASK_FAILED");
            }
            Log.ctxInfo(ctx, 'base_supplier_consumer.success  ' + JSON.stringify(payload))
            return ACK_YES
        } catch (err) {
            Log.ctxInfo(ctx, 'base_supplier_consumer.payload  ' + JSON.stringify(payload))
            Log.ctxError(ctx, 'base_supplier_consumer.CONSUMER_ERROR  ' + err.stack)
        }
    }
    static async mq_timeout() {
        const mq = new RabbitMQ();
        mq.set_exchange(CONST_AMQP.AMQP_EXCHANGE_TOPIC)
        mq.set_routing_key(CONST_AMQP.AMQP_ROUTING_KEY_COMIC_BASE)
        mq.set_queue(CONST_AMQP.AMQP_QUEUE_COMIC_BASE)
        mq.set_block_second(CONST_BUSINESS_COMIC.MQ_CONSUMER_BLOCK_SECOND)
        mq.set_pull_timeout(10, IF_EXIT_YES)
        await mq.pull(async (payload) => {
            let ctx = ContextTool.initial() // 每次拉取都是一个新的上下文
            try {
                Log.ctxInfo(ctx, 'base_consumer.start')
                await TimeTool.delay_ms(20 * 1000)
                Log.ctxInfo(ctx, 'base_consumer.success  ' + JSON.stringify(payload))
                return ACK_YES
            } catch (err) {
                Log.ctxInfo(ctx, 'base_consumer.payload  ' + JSON.stringify(payload))
                Log.ctxError(ctx, 'base_consumer.CONSUMER_ERROR  ' + err.stack)
            }
            return ACK_NO
        })
    }

}