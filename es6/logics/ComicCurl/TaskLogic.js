import Base from './Base'
import Log from '../../tools/Log'

import CONST_BUSINESS_COMIC from "../../constant/business_comic";
import CONST_AMQP from "../../constant/amqp";
import RabbitMQ from "../../libs/MQ/RabbitMQ";
import SupplierData from "../../models/CurlAvatar/Supplier/SupplierData";
import ComicData from "../../models/CurlAvatar/Comic/ComicData";
import {FIELD_CHANNEL} from "../../models/CurlAvatar/Supplier/Enum";
import GuFengService from "../../services/Comic/GuFengService";
import {FIELD_METHOD} from "../../models/CurlAvatar/Comic/Enum";
import SupplierChapterData from "../../models/CurlAvatar/SupplierChapter/SupplierChapterData";
import ArrayTool from "../../tools/ArrayTool";
import SupplierImageData from "../../models/CurlAvatar/SupplierImage/SupplierChapterData";
import {FIELD_STATUS} from "../../models/CurlAvatar/SupplierChapter/Enum";
import {FIELD_STATUS as IMAGE_FIELD_STATUS} from "../../models/CurlAvatar/SupplierImage/Enum";

export default class TaskLogic extends Base {
    static async comic_base(ctx, payload) {
        let comic_id = payload.id
        let event = payload.event
        const one_comic = await ComicData.get_comic_by_id(comic_id)
        if (!one_comic) {
            Log.ctxWarn(ctx, 'ID不存在')
            return CONST_BUSINESS_COMIC.TASK_SUCCESS
        }
        // 判断事件
        switch (event) {
            case CONST_BUSINESS_COMIC.EVENT_SUBSCRIBE:
                const supplier_list = await SupplierData.get_list_by_related_id(comic_id);
                let insert_len = supplier_list.length
                if (insert_len === 0) {
                    Log.ctxInfo(ctx, '暂无渠道')
                    break;
                }
                const mq = new RabbitMQ();
                mq.set_exchange(CONST_AMQP.AMQP_EXCHANGE_TOPIC)
                mq.set_routing_key(CONST_AMQP.AMQP_ROUTING_KEY_SUPPLIER_BASE)
                mq.set_queue(CONST_AMQP.AMQP_QUEUE_SUPPLIER_BASE)
                let payloads = [];
                for (let i = 0; i < insert_len; i++) {
                    let tmp = supplier_list[i]
                    payloads.push({
                        "id": parseInt(tmp.id),
                    })
                }
                await mq.push_multi(payloads)
                Log.ctxInfo(ctx, `notify ${insert_len} supplier success`)
                break;
            case CONST_BUSINESS_COMIC.EVENT_UNSUBSCRIBE:
                await SupplierData.offline_all_supplier_by_related_id(comic_id)
                break;
            default:
                Log.ctxWarn(ctx, 'event 异常')
        }

        return CONST_BUSINESS_COMIC.TASK_SUCCESS
    }

    static async supplier_base(ctx, payload) {
        let supplier_id = payload.id
        const one_supplier = await SupplierData.get_pne_by_id(supplier_id)
        if (!one_supplier) {
            Log.ctxWarn(ctx, 'supplier_id 不存在')
            return
        }
        // 获取渠道基本信息
        let update_supplier = {}
        let supplier_name, supplier_pic, supplier_intro = '';
        switch (one_supplier.channel) {
            case FIELD_CHANNEL.GU_FENG:
                // 处理渠道信息
                let spider_info = await GuFengService.get_base_info(ctx, one_supplier.source_id)
                supplier_name = spider_info.name
                supplier_pic = spider_info.pic
                supplier_intro = spider_info.intro
                break;
            case FIELD_CHANNEL.QI_MAN_WU:
                // TODO
                break;
            default:
                Log.ctxWarn(ctx, 'event 异常')
                return CONST_BUSINESS_COMIC.TASK_SUCCESS
        }
        // - 更新渠道基本信息
        if (supplier_name != one_supplier.name || supplier_pic != one_supplier.pic || supplier_intro != one_supplier.intro) {
            update_supplier.name = supplier_name
            update_supplier.intro = supplier_intro
            update_supplier.pic = supplier_pic
            await SupplierData.update_supplier_by_id(supplier_id, update_supplier)
        }
        // 判断是否需要自动更新漫画信息
        if (one_supplier.related_id > 0) {
            let comic_id = one_supplier.related_id
            const one_comic = await ComicData.get_comic_by_id(comic_id)
            if (!one_comic) {
                Log.ctxWarn(ctx, 'comic_id 不存在')
                return CONST_BUSINESS_COMIC.TASK_SUCCESS
            }
            // - 没有漫画名的时候，会被认定为第一次操作，可以拷贝数据过去
            if (one_comic.method == FIELD_METHOD.AUTO && one_comic.related_id == one_supplier.id && one_comic.name == '') {
                // 拷贝需要更新的信息过去
                let update = {
                    'name': one_supplier.name,
                    'pic': one_supplier.pic,
                    'intro': one_supplier.intro,
                }
                await ComicData.update_comic_by_id(comic_id, update)
            }
        }
        return CONST_BUSINESS_COMIC.TASK_SUCCESS
    }

    static async supplier_chapter(ctx, payload) {
        let supplier_id = payload.id
        const one_supplier = await SupplierData.get_pne_by_id(supplier_id)
        if (!one_supplier) {
            Log.ctxWarn(ctx, 'supplier_id 不存在')
            return
        }
        // 获取章节列表
        let supplier_list = []
        switch (one_supplier.channel) {
            case FIELD_CHANNEL.GU_FENG:
                let tab_name = one_supplier.ext_1
                supplier_list = await GuFengService.get_chapter_list(ctx, one_supplier.source_id, tab_name)
                break;
            case FIELD_CHANNEL.QI_MAN_WU:
                // TODO
                break;
            default:
                Log.ctxWarn(ctx, 'event 异常')
                return CONST_BUSINESS_COMIC.TASK_SUCCESS
        }
        // --- 获取最大的章节序号
        let len_supplier_list = supplier_list.length
        let supplier_list_index = len_supplier_list - 1
        let max_sequence = supplier_list[supplier_list_index]['sequence']
        // - 计算需要增量爬取的章节信息
        const chapter_list = await SupplierChapterData.get_list_by_related_id(supplier_id)
        let insert_list = this.supplier_chapter_diff(ctx, chapter_list, supplier_list)
        // 需要增量的数量
        let insert_len = insert_list.length
        if (insert_len === 0) {
            Log.ctxInfo(ctx, '暂无需要爬取的章节列表信息')
            return CONST_BUSINESS_COMIC.TASK_SUCCESS
        }
        // - 事务开始
        // --- 待插入的数据
        let insert_chapter_list = [];
        for (let i = 0; i < insert_len; i++) {
            let tmp = {
                'related_id': supplier_id,
                'sequence': insert_list[i].sequence,
                'name': insert_list[i].name,
                'status': FIELD_STATUS.WAIT,
            }
            insert_chapter_list.push(tmp)
        }
        await SupplierChapterData.do_insert(insert_chapter_list)
        // --- 查询刚刚插入的数据对应的ID组
        let sequence_list = ArrayTool.column(insert_chapter_list, "sequence")
        let inserted_chapter_list = await SupplierChapterData.get_list_by_id_sequence_list(supplier_id, sequence_list)
        // ---- 数据转map结构
        let inserted_chapter_map = ArrayTool.map_by_key(inserted_chapter_list, "sequence")
        // --- 通知执行章节爬取任务
        const mq = new RabbitMQ();
        mq.set_exchange(CONST_AMQP.AMQP_EXCHANGE_TOPIC)
        mq.set_routing_key(CONST_AMQP.AMQP_ROUTING_KEY_SUPPLIER_CHAPTER)
        mq.set_queue(CONST_AMQP.AMQP_QUEUE_SUPPLIER_CHAPTER_INFO)
        let payloads = [];
        for (let i = 0; i < insert_len; i++) {
            let tmp = insert_list[i]
            let id = inserted_chapter_map[tmp.sequence].id
            payloads.push({
                "id": id,
                "link": `https://www.gufengmh8.com${tmp.link}`,
            })
        }
        await mq.push_multi(payloads)
        // --- 设置当前渠道最大顺序号
        let update_supplier = {
            'max_sequence': max_sequence,
        }
        await SupplierData.update_supplier_by_id(supplier_id, update_supplier)
        // - 事务结束
        return CONST_BUSINESS_COMIC.TASK_SUCCESS
    }

    // 计算差异章节
    static supplier_chapter_diff(ctx, record_chapter, spider_chapter) {
        let real_list = [];
        let map_record = {} // key 顺序号
        let len_record_chapter = record_chapter.length
        for (let i = 0; i < len_record_chapter; i++) {
            let sequence = record_chapter[i].sequence
            map_record[sequence] = 1
        }
        let len_spider_chapter = spider_chapter.length
        if (len_spider_chapter === 0) {
            return real_list
        }
        for (let i = 0; i < len_spider_chapter; i++) {
            let one_spider_chapter = spider_chapter[i]
            let sequence = one_spider_chapter.sequence
            if (map_record[sequence]) { // 已有章节就跳过
                continue
            }
            let tmp = JSON.parse(JSON.stringify(one_spider_chapter)) // 深拷贝数据
            real_list.push(tmp)
        }
        return real_list
    }

    static async supplier_image(ctx, payload) {
        let chapter_id = payload.id
        let link = payload.link
        // 检测章节信息
        const one_chapter = await SupplierChapterData.get_chapter_by_id(chapter_id)
        if (!one_chapter) {
            Log.ctxWarn(ctx, 'chapter_id 不存在')
            return CONST_BUSINESS_COMIC.TASK_SUCCESS
        }
        // 标记该章节之前的图片为删除状态
        await SupplierImageData.delete_by_related_id(chapter_id)
        // 爬取图片列表
        let image_list = await GuFengService.get_image_list(ctx, link)
        let len_image_list = image_list.length
        if (!len_image_list || len_image_list === 0) {
            return CONST_BUSINESS_COMIC.TASK_SUCCESS
        }
        // 插入图片
        let inserts = []
        for (let i = 0; i < len_image_list; i++) {
            inserts.push({
                'src_origin': image_list[i],
                'related_id': chapter_id,
                'sequence': i + 1,
                'status': IMAGE_FIELD_STATUS.ONLINE,
            })
        }
        await SupplierImageData.do_insert(inserts)
        // 设置章节已爬取完毕
        Log.ctxInfo(ctx, `one_chapter.id ${one_chapter.id}`)
        await SupplierChapterData.set_status_ok_by_id(one_chapter.id)

        return CONST_BUSINESS_COMIC.TASK_SUCCESS
    }

    static async notify_sub(ctx, comic_id) {
        let payloads = [];
        if (comic_id === undefined) {
            let comic_list = await ComicData.get_list_available()
            let len_comic_list = comic_list.length
            for (let i = 0; i < len_comic_list; i++) {
                let tmp = {
                    "id": parseInt(comic_list[i].id),
                    "event": CONST_BUSINESS_COMIC.EVENT_SUBSCRIBE,
                }
                payloads.push(tmp)
            }
        } else {
            let tmp = {
                "id": parseInt(comic_id),
                "event": CONST_BUSINESS_COMIC.EVENT_SUBSCRIBE,
            }
            payloads.push(tmp)
        }
        let len_payloads = payloads.length
        if (len_payloads === 0) {
            Log.ctxWarn(ctx, '暂无需要通知订阅的漫画')
            return
        }
        const mq = new RabbitMQ();
        mq.set_exchange(CONST_AMQP.AMQP_EXCHANGE_TOPIC)
        mq.set_routing_key(CONST_AMQP.AMQP_ROUTING_KEY_COMIC_BASE)
        mq.set_queue(CONST_AMQP.AMQP_QUEUE_COMIC_BASE)
        await mq.push_multi(payloads)

        Log.ctxInfo(ctx, `通知订阅成功,总计 ${len_payloads} 个`)
    }
}