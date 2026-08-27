# GetRetrievalEventGraph200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**edges** | [**List[GetGlobalSkillGraph200ResponseEdgesInner]**](GetGlobalSkillGraph200ResponseEdgesInner.md) |  |
**metadata** | [**GetRetrievalEventGraph200ResponseAllOfMetadata**](GetRetrievalEventGraph200ResponseAllOfMetadata.md) |  |
**mode** | **str** |  | [optional]
**nodes** | [**List[GetGlobalSkillGraph200ResponseNodesInner]**](GetGlobalSkillGraph200ResponseNodesInner.md) |  |
**root** | [**GetRetrievalEventGraph200ResponseAllOfRoot1**](GetRetrievalEventGraph200ResponseAllOfRoot1.md) |  |
**memories** | **List[object]** |  |

## Example

```python
from openapi_client.models.get_retrieval_event_graph200_response import GetRetrievalEventGraph200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetRetrievalEventGraph200Response from a JSON string
get_retrieval_event_graph200_response_instance = GetRetrievalEventGraph200Response.from_json(json)
# print the JSON string representation of the object
print(GetRetrievalEventGraph200Response.to_json())

# convert the object into a dict
get_retrieval_event_graph200_response_dict = get_retrieval_event_graph200_response_instance.to_dict()
# create an instance of GetRetrievalEventGraph200Response from a dict
get_retrieval_event_graph200_response_from_dict = GetRetrievalEventGraph200Response.from_dict(get_retrieval_event_graph200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
