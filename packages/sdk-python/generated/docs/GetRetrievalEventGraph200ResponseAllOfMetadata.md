# GetRetrievalEventGraph200ResponseAllOfMetadata


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**edges** | **int** |  |
**generated_at** | **str** |  |
**include_history** | **bool** |  |
**limits** | [**GetGlobalSkillGraph200ResponseMetadataLimits**](GetGlobalSkillGraph200ResponseMetadataLimits.md) |  |
**nodes** | **int** |  |
**truncated** | **bool** |  |
**truncated_edges** | **int** |  |
**truncated_nodes** | **int** |  |

## Example

```python
from openapi_client.models.get_retrieval_event_graph200_response_all_of_metadata import GetRetrievalEventGraph200ResponseAllOfMetadata

# TODO update the JSON string below
json = "{}"
# create an instance of GetRetrievalEventGraph200ResponseAllOfMetadata from a JSON string
get_retrieval_event_graph200_response_all_of_metadata_instance = GetRetrievalEventGraph200ResponseAllOfMetadata.from_json(json)
# print the JSON string representation of the object
print(GetRetrievalEventGraph200ResponseAllOfMetadata.to_json())

# convert the object into a dict
get_retrieval_event_graph200_response_all_of_metadata_dict = get_retrieval_event_graph200_response_all_of_metadata_instance.to_dict()
# create an instance of GetRetrievalEventGraph200ResponseAllOfMetadata from a dict
get_retrieval_event_graph200_response_all_of_metadata_from_dict = GetRetrievalEventGraph200ResponseAllOfMetadata.from_dict(get_retrieval_event_graph200_response_all_of_metadata_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
