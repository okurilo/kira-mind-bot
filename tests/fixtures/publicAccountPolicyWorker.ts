import { withAccountAiOperation,withAccountAiTask,withBackgroundAiTask,accountPolicyError } from '../../ai/accountPolicy';
import { openaiProviderAdapter } from '../../ai/providers/openai';
import { openrouterProviderAdapter } from '../../ai/providers/openrouter';
import { generateOpenAiImage } from '../../services/imageGenerationService';
import { ReminderService } from '../../services/ReminderService';

process.on('message',(raw:unknown)=>{
    const input=raw as {type?:string;id:string;operationId:string;action:string;background?:boolean};
    if(input?.type!=='fixture-call')return;
    void withAccountAiOperation({id:input.operationId,background:Boolean(input.background)},async()=>{
        try{
            let extra: Record<string, unknown> = {};
            if(input.action==='text')await openaiProviderAdapter.createChatCompletion('synthetic-model',{messages:[{role:'user',content:'Synthetic safe request'}]});
            else if(input.action==='embedding')await openaiProviderAdapter.createEmbedding!('synthetic-embedding',{input:'Synthetic memory',outputDimension:4});
            else if(input.action==='image')await generateOpenAiImage('Synthetic landscape',false);
            else if(input.action==='fallback')await openrouterProviderAdapter.createChatCompletion('synthetic-model',{messages:[{role:'user',content:'Synthetic safe request'}]});
            else if(input.action==='background-batch')await withAccountAiTask({id:input.operationId,background:true},async()=>{
                for(let i=0;i<3;i++)await openaiProviderAdapter.createChatCompletion('synthetic-model',{messages:[{role:'user',content:'Synthetic batch stage'}]});
            });
            else if(input.action==='foreground-optional'){
                await openaiProviderAdapter.createChatCompletion('synthetic-model',{messages:[{role:'user',content:'Synthetic direct answer'}]});
                try{await withBackgroundAiTask('fixture-followup',input.operationId,()=>openaiProviderAdapter.createChatCompletion('synthetic-model',{messages:[{role:'user',content:'Synthetic optional review'}]}));}
                catch(error){extra.optionalCode=accountPolicyError(error)?.code;}
            }
            else if(input.action==='reminder'){
                let saved=0,timers=0,memory=0;
                const service=new ReminderService({save:async()=>{saved++;},register:()=>{},schedule:()=>{timers++;},syncMemory:async()=>{memory++;}});
                await service.createReminder({chat:{id:101,type:'private'},session:{reminders:[]}} as any,
                    {id:'synthetic-reminder',text:'Учебное действие',dueDate:new Date('2099-01-01T12:00:00Z')});
                extra={saved,timers,memory};
            }
            else throw Error('Unknown fixture operation');
            process.send?.({type:'fixture-result',id:input.id,ok:true,...extra});
        }catch(error){const safe=accountPolicyError(error);process.send?.({type:'fixture-result',id:input.id,ok:false,code:safe?.code || 'fixture_error'});}
    });
});
process.send?.({type:'fixture-ready'});
